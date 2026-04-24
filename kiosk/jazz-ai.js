/**
 * Seestar Jazz AI Engine — Magenta MusicRNN + Tone.js
 *
 * Drop-in replacement for jazz.js with AI-generated improvisation.
 * Same public API: SeestarJazz.feed(), .toggle(), .setKey(), etc.
 *
 * Requires (loaded via CDN in kiosk.html):
 *   - @magenta/music (MusicRNN, sequences)
 *   - Tone.js
 */

var SeestarJazzAI = (function() {
    "use strict";

    // ── Keys & Scales ───────────────────────────────────────────
    var NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

    var SCALES = {
        dorian:      { name: "Dorian",      intervals: [0, 2, 3, 5, 7, 9, 10] },
        mixolydian:  { name: "Mixolydian",  intervals: [0, 2, 4, 5, 7, 9, 10] },
        blues:       { name: "Blues",       intervals: [0, 3, 5, 6, 7, 10] },
        minor:       { name: "Minor nat.",  intervals: [0, 2, 3, 5, 7, 8, 10] },
        major:       { name: "Major",       intervals: [0, 2, 4, 5, 7, 9, 11] },
        pentatonic:  { name: "Pentatonic",  intervals: [0, 2, 4, 7, 9] },
        minpent:     { name: "Min. pent.",  intervals: [0, 3, 5, 7, 10] },
        wholetone:   { name: "Whole tone",  intervals: [0, 2, 4, 6, 8, 10] },
        diminished:  { name: "Diminished",  intervals: [0, 2, 3, 5, 6, 8, 9, 11] }
    };

    // ii-V-I-I-ii-V-I-iv jazz progression
    var PROGRESSION = ["ii", "V", "I", "I", "ii", "V", "I", "iv"];

    // Chord root offsets + quality for Magenta chord conditioning
    var CHORD_DEFS = {
        ii:  [2, "m7"],
        V:   [7, "7"],
        I:   [0, "maj7"],
        iv:  [5, "m7"]
    };

    function chordForKey(chordDeg, key) {
        var d = CHORD_DEFS[chordDeg];
        if (!d) return "C";
        return NOTE_NAMES[(key + d[0]) % 12] + d[1];
    }

    // ── Configuration ───────────────────────────────────────────
    var rootNote = 0;
    var scaleName = "dorian";
    var currentScale = SCALES.dorian;
    var BASE_MIDI = 60; // C4

    // ── State ───────────────────────────────────────────────────
    var running = false;
    var volume = 0.5;
    var modelReady = false;
    var modelLoading = false;

    var lastStacked = -1;
    var lastDropped = -1;
    var chordIndex = 0;
    var currentState = "idle";
    var currentRA = 12;
    var currentDec = 0;
    var currentSNR = 5;
    var integrationSec = 0;
    var starDensity = 0;
    var autoTonality = true;
    var lastKeyChange = 0;
    var colorDiversity = 0; // 0–1 from image analysis (Shannon entropy normalized)
    // Octave range driven by color diversity:
    // low diversity → 2 octaves (C3–C5), full diversity → 7 octaves (A0–C8)
    var octaveLow = 48;   // MIDI note lower bound (C3)
    var octaveHigh = 72;  // MIDI note upper bound (C5)

    // ── Magenta ─────────────────────────────────────────────────
    var rnn = null;
    var CHECKPOINT_URL = "lib/magenta-model/";
    var isGenerating = false;
    var lastSeed = null;
    var genLoopTimer = null; // continuous generation loop

    // ── Tone.js ─────────────────────────────────────────────────
    var pianoSampler = null; // Salamander Grand Piano
    var melodySynth = null;  // fallback FM synth (used until sampler loads)
    var padSynth = null;
    var bassSynth = null;
    var reverb = null;
    var chorus = null;
    var masterVol = null;
    var toneStarted = false;
    var samplerReady = false;

    // ── MIDI ────────────────────────────────────────────────────
    var midiAccess = null;
    var midiOutput = null;
    var midiEnabled = false;
    var midiChannel = 0;
    var midiDevices = [];
    var synthEnabled = true;
    var onMidiDevicesChangedCb = null;

    // ── Loops ───────────────────────────────────────────────────
    var chordLoop = null;
    var bassLoop = null;
    var fillLoop = null;
    var bassNoteIdx = 0;

    // ── Helpers ─────────────────────────────────────────────────

    function midiToNote(midi) {
        return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    }

    // Clamp MIDI note to current octave range (driven by color diversity)
    function clampMidi(midi) {
        return Math.max(octaveLow, Math.min(octaveHigh, midi));
    }

    // Update octave range from color diversity (0–1)
    // 0 = monochrome → narrow (C3–C5, 2 octaves)
    // 1 = full rainbow → wide (A0–C8, full piano)
    function updateOctaveRange() {
        // Linear interpolation: low end drops from C3(48) to A0(21)
        // high end rises from C5(72) to C8(108)
        octaveLow = Math.round(48 - colorDiversity * 27);   // 48 → 21
        octaveHigh = Math.round(72 + colorDiversity * 36);   // 72 → 108
    }

    function scaleNote(index) {
        var s = currentScale.intervals;
        var len = s.length;
        var oct = Math.floor(index / len);
        var deg = ((index % len) + len) % len;
        return rootNote + s[deg] + oct * 12;
    }

    function raToScaleIndex(ra) {
        return Math.floor((ra / 24) * currentScale.intervals.length * 2);
    }

    function decToOctaveShift(dec) {
        if (dec > 30) return 1;
        if (dec < -30) return -1;
        return 0;
    }

    function snrToTemperature(snr) {
        // Low SNR → conservative (0.7), high SNR → adventurous (1.3)
        return Math.min(1.3, Math.max(0.7, 0.7 + (snr / 30) * 0.6));
    }

    function densityToSteps(density) {
        if (density < 0.005) return 8;
        if (density < 0.02) return 12;
        if (density < 0.05) return 16;
        if (density < 0.10) return 24;
        return 32;
    }

    // ── MIDI output ─────────────────────────────────────────────

    function sendMidiNoteOn(note, velocity) {
        if (!midiOutput || !midiEnabled) return;
        midiOutput.send([0x90 | midiChannel, note, Math.round(velocity * 127)]);
    }

    function sendMidiNoteOff(note) {
        if (!midiOutput || !midiEnabled) return;
        midiOutput.send([0x80 | midiChannel, note, 0]);
    }

    function sendMidiNote(note, velocity, durationMs) {
        sendMidiNoteOn(note, velocity);
        setTimeout(function() { sendMidiNoteOff(note); }, durationMs);
    }

    function allMidiNotesOff() {
        if (!midiOutput) return;
        midiOutput.send([0xB0 | midiChannel, 123, 0]);
    }

    // ── MIDI device management ──────────────────────────────────

    function refreshMidiDevices() {
        midiDevices = [];
        if (!midiAccess) return;
        midiAccess.outputs.forEach(function(output) {
            midiDevices.push({id: output.id, name: output.name});
        });
        if (onMidiDevicesChangedCb) onMidiDevicesChangedCb(midiDevices);
    }

    function initMidi() {
        if (!navigator.requestMIDIAccess) return Promise.resolve(false);
        return navigator.requestMIDIAccess({sysex: false}).then(function(access) {
            midiAccess = access;
            refreshMidiDevices();
            midiAccess.onstatechange = function() { refreshMidiDevices(); };
            if (!midiOutput && midiDevices.length > 0) selectMidiDevice(midiDevices[0].id);
            return true;
        }).catch(function() { return false; });
    }

    function selectMidiDevice(deviceId) {
        if (!midiAccess) return false;
        allMidiNotesOff();
        var out = midiAccess.outputs.get(deviceId);
        if (out) { midiOutput = out; midiEnabled = true; return true; }
        return false;
    }

    // ── Tone.js setup ───────────────────────────────────────────

    async function initTone() {
        if (pianoSampler || melodySynth) return;

        masterVol = new Tone.Volume(Tone.gainToDb(volume)).toDestination();

        // Reverb must be generated (async) before use
        reverb = new Tone.Reverb({decay: 3, wet: 0.35});
        await reverb.generate();
        reverb.connect(masterVol);

        chorus = new Tone.Chorus({frequency: 1.5, delayTime: 3.5, depth: 0.5, wet: 0.3});
        chorus.connect(reverb);
        chorus.start();

        // Salamander Grand Piano (sampler) — primary melody instrument
        // Note names use 's' for sharp in filenames (Ds1 = D#1)
        var sampleMap = {
            "A0": "A0.mp3", "C1": "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
            "A1": "A1.mp3", "C2": "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
            "A2": "A2.mp3", "C3": "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
            "A3": "A3.mp3", "C4": "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
            "A4": "A4.mp3", "C5": "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
            "A5": "A5.mp3", "C6": "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
            "A6": "A6.mp3", "C7": "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
            "A7": "A7.mp3", "C8": "C8.mp3"
        };

        pianoSampler = new Tone.Sampler({
            urls: sampleMap,
            baseUrl: "lib/salamander/",
            release: 1.2,
            onload: function() {
                samplerReady = true;
                console.log("[jazz-ai] Salamander Grand Piano loaded (30 samples)");
            }
        });
        pianoSampler.connect(chorus);

        // FM synth fallback — used until sampler loads
        melodySynth = new Tone.PolySynth(Tone.FMSynth, {
            maxPolyphony: 8,
            harmonicity: 3.01,
            modulationIndex: 14,
            oscillator: {type: "triangle"},
            envelope: {attack: 0.005, decay: 0.5, sustain: 0.15, release: 1.4},
            modulation: {type: "square"},
            modulationEnvelope: {attack: 0.002, decay: 0.2, sustain: 0, release: 0.5}
        });
        melodySynth.connect(chorus);
        melodySynth.volume.value = -6;

        // Warm pad
        padSynth = new Tone.PolySynth(Tone.Synth, {
            maxPolyphony: 8,
            oscillator: {type: "sine"},
            envelope: {attack: 1.5, decay: 2, sustain: 0.3, release: 2.5}
        });
        padSynth.connect(reverb);
        padSynth.volume.value = -14;

        // Walking bass — also uses piano sampler for bass range
        bassSynth = new Tone.MonoSynth({
            oscillator: {type: "triangle"},
            filter: {type: "lowpass", frequency: 600, Q: 2},
            envelope: {attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3},
            filterEnvelope: {attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3, baseFrequency: 200, octaves: 2}
        });
        bassSynth.connect(reverb);
        bassSynth.volume.value = -6;
    }

    // Get the active melody instrument (piano sampler if loaded, FM fallback otherwise)
    function getMelody() {
        return (samplerReady && pianoSampler) ? pianoSampler : melodySynth;
    }

    async function startTone() {
        if (!toneStarted) {
            await Tone.start();
            toneStarted = true;
        }
    }

    // ── Magenta model ───────────────────────────────────────────

    function setPreloadedModel(preloaded) {
        if (modelReady) return;
        rnn = preloaded;
        modelReady = true;
        modelLoading = false;
        console.log("[jazz-ai] Using preloaded MusicRNN");
    }

    async function loadModel() {
        if (modelReady || modelLoading) return;
        modelLoading = true;
        try {
            rnn = new mm.MusicRNN(CHECKPOINT_URL);
            await rnn.initialize();
            modelReady = true;
            console.log("[jazz-ai] MusicRNN chord_pitches_improv loaded");
        } catch(e) {
            console.error("[jazz-ai] Model load failed:", e);
            modelReady = false;
        }
        modelLoading = false;
    }

    // ── Seed builder ────────────────────────────────────────────

    function buildSeed(ra, dec, snr) {
        var idx = raToScaleIndex(ra);
        var octShift = decToOctaveShift(dec);
        var stepsPerQ = 4;
        var notes = [];

        for (var i = 0; i < 4; i++) {
            var semi = scaleNote(idx + i) + (octShift * 12);
            var pitch = BASE_MIDI + semi;
            pitch = Math.max(36, Math.min(96, pitch));
            notes.push({
                pitch: pitch,
                quantizedStartStep: i * stepsPerQ,
                quantizedEndStep: (i + 1) * stepsPerQ - 1
            });
        }

        return {
            notes: notes,
            quantizationInfo: {stepsPerQuarter: stepsPerQ},
            totalQuantizedSteps: 4 * stepsPerQ,
            tempos: [{time: 0, qpm: currentState === "slewing" ? 140 : 90}]
        };
    }

    // ── Generate & play ─────────────────────────────────────────

    async function generateAndPlay() {
        if (!modelReady || isGenerating || !running) return;
        isGenerating = true;

        try {
            var seed = lastSeed || buildSeed(currentRA, currentDec, currentSNR);
            var temperature = snrToTemperature(currentSNR);
            var steps = densityToSteps(starDensity);

            // Build chord progression for conditioning (one chord per ~4 steps)
            var chordProgression = [];
            var chordsNeeded = Math.max(1, Math.ceil(steps / 4));
            for (var c = 0; c < chordsNeeded; c++) {
                var ci = (chordIndex + c) % PROGRESSION.length;
                chordProgression.push(chordForKey(PROGRESSION[ci], rootNote));
            }

            var result = await rnn.continueSequence(
                seed,
                steps,
                temperature,
                chordProgression
            );

            if (result && result.notes && result.notes.length > 0) {
                var phraseDuration = playSequence(result);

                // Chain: last 4 notes become next seed
                var tailNotes = result.notes.slice(-4);
                if (tailNotes.length >= 2) {
                    var minStep = tailNotes[0].quantizedStartStep;
                    lastSeed = {
                        notes: tailNotes.map(function(n) {
                            return {
                                pitch: n.pitch,
                                quantizedStartStep: n.quantizedStartStep - minStep,
                                quantizedEndStep: n.quantizedEndStep - minStep
                            };
                        }),
                        quantizationInfo: seed.quantizationInfo,
                        totalQuantizedSteps: tailNotes[tailNotes.length - 1].quantizedEndStep - minStep,
                        tempos: seed.tempos
                    };
                }

                // Advance chord index
                chordIndex = (chordIndex + chordsNeeded) % PROGRESSION.length;

                // Schedule next generation after this phrase finishes
                scheduleNextGeneration(phraseDuration);
            } else {
                // Empty result — retry in a few seconds
                scheduleNextGeneration(3);
            }
        } catch(e) {
            console.warn("[jazz-ai] Generation error:", e);
            lastSeed = null; // reset bad seed
            scheduleNextGeneration(4);
        }

        isGenerating = false;
    }

    function playSequence(seq) {
        if (!seq || !seq.notes) return 0;
        var qpm = (seq.tempos && seq.tempos[0]) ? seq.tempos[0].qpm : 90;
        var spq = (seq.quantizationInfo && seq.quantizationInfo.stepsPerQuarter) ? seq.quantizationInfo.stepsPerQuarter : 4;
        var secPerStep = 60 / (qpm * spq);
        var now = Tone.now();
        var maxEnd = 0;

        seq.notes.forEach(function(note) {
            var startTime = now + note.quantizedStartStep * secPerStep;
            var duration = Math.max(0.1, (note.quantizedEndStep - note.quantizedStartStep) * secPerStep);
            var clamped = clampMidi(note.pitch);
            var noteName = midiToNote(clamped);
            // Humanize velocity — SNR maps baseline, random spread
            var baseVel = Math.min(0.8, Math.max(0.25, currentSNR / 25));
            var velocity = baseVel + (Math.random() - 0.5) * 0.15;
            velocity = Math.max(0.15, Math.min(0.9, velocity));

            if (synthEnabled && getMelody()) {
                getMelody().triggerAttackRelease(noteName, duration, startTime, velocity);
            }

            if (midiEnabled && midiOutput) {
                var delayMs = Math.max(0, (startTime - Tone.now()) * 1000);
                (function(m, v, d) {
                    setTimeout(function() { sendMidiNote(m, v, d); }, delayMs);
                })(clamped, velocity, duration * 1000);
            }

            var endTime = startTime + duration - now;
            if (endTime > maxEnd) maxEnd = endTime;
        });

        return maxEnd; // total phrase duration in seconds
    }

    // ── Continuous generation loop ──────────────────────────────

    function scheduleNextGeneration(delaySec) {
        if (genLoopTimer) clearTimeout(genLoopTimer);
        if (!running) return;
        genLoopTimer = setTimeout(function() {
            if (running && modelReady) {
                generateAndPlay();
            } else if (running) {
                // Model not ready yet — play procedural, retry
                playProceduralNote();
                scheduleNextGeneration(3);
            }
        }, delaySec * 1000);
    }

    function startContinuousGeneration() {
        // Start first generation immediately (or after short delay for model)
        if (modelReady) {
            generateAndPlay();
        } else {
            // Play procedural while loading
            playProceduralNote();
            scheduleNextGeneration(2);
        }
    }

    function stopContinuousGeneration() {
        if (genLoopTimer) { clearTimeout(genLoopTimer); genLoopTimer = null; }
    }

    // ── Background loops (bass + pad + fills) ───────────────────

    function startBassWalk() {
        if (bassLoop) return;
        bassNoteIdx = 0;

        var interval = currentState === "slewing" ? "8n" : "4n";
        bassLoop = new Tone.Loop(function(time) {
            if (!running) return;
            var s = currentScale.intervals;
            var deg = bassNoteIdx % s.length;
            var semi = rootNote + s[deg];
            // Chromatic approach note ~20% of the time
            if (Math.random() < 0.2) semi += (Math.random() < 0.5 ? 1 : -1);
            var midi = semi + 36; // C2 range
            midi = Math.max(28, Math.min(55, midi));
            var noteName = midiToNote(midi);

            if (synthEnabled && bassSynth) {
                bassSynth.triggerAttackRelease(noteName, "8n", time, 0.55);
            }
            if (midiEnabled && midiOutput) {
                sendMidiNote(midi, 0.5, 400);
            }
            bassNoteIdx++;
        }, interval);
        bassLoop.start(0);
    }

    function startChordPad() {
        if (chordLoop) return;
        chordLoop = new Tone.Loop(function(time) {
            if (!running) return;
            var chord = PROGRESSION[chordIndex % PROGRESSION.length];
            var chordIntervals = {
                ii:  [2, 5, 9],
                V:   [7, 11, 14],
                I:   [0, 4, 7],
                iv:  [5, 8, 12]
            };
            var intervals = chordIntervals[chord] || [0, 4, 7];
            var notes = intervals.map(function(semi) {
                return midiToNote(rootNote + semi + 48);
            });
            if (synthEnabled && padSynth) {
                padSynth.triggerAttackRelease(notes, "2n", time, 0.12);
            }
        }, "1m");
        chordLoop.start(0);
    }

    function startFillNotes() {
        updateFillRate();
    }

    function updateFillRate() {
        if (fillLoop) { fillLoop.stop(); fillLoop.dispose(); fillLoop = null; }
        if (!running || starDensity < 0.005) return;

        var interval;
        if (starDensity < 0.02) interval = 6;
        else if (starDensity < 0.05) interval = 3;
        else if (starDensity < 0.10) interval = 1.5;
        else interval = 0.8;

        fillLoop = new Tone.Loop(function(time) {
            if (!running || currentState === "idle") return;
            var s = currentScale.intervals;
            var deg = Math.floor(Math.random() * s.length);
            // Random octave within current range
            var rangeOctaves = Math.max(1, Math.floor((octaveHigh - octaveLow) / 12));
            var oct = Math.floor(Math.random() * rangeOctaves);
            var midi = clampMidi(octaveLow + rootNote + s[deg] + oct * 12);
            var noteName = midiToNote(midi);
            var vel = 0.08 + Math.random() * 0.12; // ghost notes

            if (synthEnabled && getMelody()) {
                getMelody().triggerAttackRelease(noteName, "16n", time, vel);
            }
            if (midiEnabled && midiOutput) {
                sendMidiNote(midi, vel, 150);
            }
        }, interval);
        fillLoop.start(0);
    }

    function stopLoops() {
        if (bassLoop) { bassLoop.stop(); bassLoop.dispose(); bassLoop = null; }
        if (chordLoop) { chordLoop.stop(); chordLoop.dispose(); chordLoop = null; }
        if (fillLoop) { fillLoop.stop(); fillLoop.dispose(); fillLoop = null; }
        stopContinuousGeneration();
        Tone.Transport.stop();
        Tone.Transport.cancel();
        allMidiNotesOff();
    }

    function restartLoops() {
        stopLoops();
        chordIndex = 0;
        Tone.Transport.bpm.value = currentState === "slewing" ? 140 : 90;
        Tone.Transport.start();
        startBassWalk();
        startChordPad();
        startFillNotes();
        startContinuousGeneration();
    }

    // ── Dissonance (dropped frame) ──────────────────────────────

    function playDissonance() {
        if (!running) return;
        var semi = Math.floor(Math.random() * 12);
        var n1 = BASE_MIDI + rootNote + semi;
        var n2 = n1 + 1; // minor 2nd = maximum dissonance
        if (synthEnabled && getMelody()) {
            getMelody().triggerAttackRelease(midiToNote(n1), "32n", undefined, 0.25);
            getMelody().triggerAttackRelease(midiToNote(n2), "32n", "+0.02", 0.2);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(n1, 0.2, 100);
            sendMidiNote(n2, 0.15, 100);
        }
    }

    // ── Procedural fallback ─────────────────────────────────────

    function playProceduralNote() {
        if (!running) return;
        var idx = raToScaleIndex(currentRA);
        var octShift = decToOctaveShift(currentDec);
        var semi = scaleNote(idx) + (octShift * 12);
        var midi = clampMidi(BASE_MIDI + semi);
        var noteName = midiToNote(midi);
        var vel = Math.min(0.8, Math.max(0.2, currentSNR / 25));
        var dur = Math.min(2, 0.4 + integrationSec / 600);

        if (synthEnabled && getMelody()) {
            getMelody().triggerAttackRelease(noteName, dur, undefined, vel);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(midi, vel, dur * 1000);
        }
    }

    // ── Public API ──────────────────────────────────────────────

    async function start() {
        await initTone();
        await startTone();
        initMidi();
        loadModel(); // async — procedural fallback until ready

        running = true;
        Tone.Transport.bpm.value = currentState === "slewing" ? 140 : 90;
        Tone.Transport.start();
        startBassWalk();
        startChordPad();
        startFillNotes();
        startContinuousGeneration();
    }

    function stop() {
        running = false;
        stopLoops();
        lastSeed = null;
    }

    function toggle() {
        if (running) { stop(); return false; }
        else { start(); return true; }
    }

    function setKey(noteIndex) {
        rootNote = noteIndex % 12;
        lastSeed = null;
        if (running) restartLoops();
    }

    function setScale(name) {
        if (!SCALES[name]) return;
        scaleName = name;
        currentScale = SCALES[name];
        lastSeed = null;
        if (running) restartLoops();
    }

    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        if (masterVol) masterVol.volume.value = Tone.gainToDb(volume);
    }

    function setReverb(wet) {
        if (reverb) reverb.wet.value = Math.max(0, Math.min(1, wet));
    }

    function setStarDensity(ratio) {
        starDensity = Math.max(0, Math.min(1, ratio));
        updateFillRate();
    }

    function setColorDiversity(d) {
        colorDiversity = Math.max(0, Math.min(1, d));
        updateOctaveRange();
    }

    function suggestKey(newKey) {
        if (!autoTonality || newKey === rootNote) return;
        if (Date.now() - lastKeyChange < 30000) return;
        lastKeyChange = Date.now();
        rootNote = newKey % 12;
        lastSeed = null;
        if (running) restartLoops();
    }

    function suggestScale(name) {
        if (!autoTonality || !SCALES[name] || name === scaleName) return;
        scaleName = name;
        currentScale = SCALES[name];
        lastSeed = null;
        if (running) restartLoops();
    }

    // ── Feed ────────────────────────────────────────────────────

    function feed(data) {
        if (!running) return;

        if (data.state && data.state !== currentState) {
            currentState = data.state;
            var bpm = currentState === "slewing" ? 140 : 90;
            Tone.Transport.bpm.rampTo(bpm, 2);

            // Restart bass with new tempo feel
            if (bassLoop) { bassLoop.stop(); bassLoop.dispose(); bassLoop = null; }
            startBassWalk();

            if (currentState === "idle") {
                if (padSynth) padSynth.volume.rampTo(-24, 2);
                if (bassSynth) bassSynth.volume.rampTo(-18, 2);
            } else {
                if (padSynth) padSynth.volume.rampTo(-14, 1);
                if (bassSynth) bassSynth.volume.rampTo(-6, 1);
            }
        }

        if (typeof data.ra === "number") currentRA = data.ra;
        if (typeof data.dec === "number") currentDec = data.dec;
        if (typeof data.snr === "number") currentSNR = data.snr;

        if (data.stats && data.stats.integration_time) {
            var it = data.stats.integration_time;
            if (typeof it === "string" && it.indexOf(":") !== -1) {
                var parts = it.split(":");
                integrationSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2] || 0);
            } else {
                integrationSec = parseFloat(it) || 0;
            }
        }

        // New stack → inject energy: reset seed from fresh telescope data
        if (data.stats && data.stats.stacked_frame != null) {
            var stacked = parseInt(data.stats.stacked_frame);
            if (lastStacked >= 0 && stacked > lastStacked) {
                // New stack frame — build fresh seed from current RA/Dec
                lastSeed = buildSeed(currentRA, currentDec, currentSNR);
            }
            lastStacked = stacked;
        }

        // Dropped frame → dissonance
        if (data.stats && data.stats.dropped_frame != null) {
            var dropped = parseInt(data.stats.dropped_frame);
            if (lastDropped >= 0 && dropped > lastDropped) {
                playDissonance();
            }
            lastDropped = dropped;
        }
    }

    function feedOverlay(state, stacked) {
        if (!running) return;
        if (state && state !== currentState) feed({state: state});
        if (stacked != null) {
            var n = parseInt(stacked);
            if (!isNaN(n)) feed({stats: {stacked_frame: n}});
        }
    }

    // ── Accessors ───────────────────────────────────────────────

    return {
        toggle: toggle, start: start, stop: stop,
        feed: feed, feedOverlay: feedOverlay,
        setVolume: setVolume, getVolume: function() { return volume; },
        isRunning: function() { return running; },
        setReverb: setReverb,
        setStarDensity: setStarDensity, setColorDiversity: setColorDiversity,
        suggestKey: suggestKey, suggestScale: suggestScale,
        setAutoTonality: function(on) { autoTonality = on; },
        getAutoTonality: function() { return autoTonality; },
        setKey: setKey, setScale: setScale,
        getKey: function() { return rootNote; },
        getKeyName: function() { return NOTE_NAMES[rootNote]; },
        getScaleName: function() { return scaleName; },
        getScaleDisplayName: function() { return currentScale.name; },
        getNoteNames: function() { return NOTE_NAMES; },
        getScales: function() { return SCALES; },
        initMidi: initMidi, selectMidiDevice: selectMidiDevice,
        getMidiDevices: function() { return midiDevices; },
        getMidiEnabled: function() { return midiEnabled; },
        setMidiEnabled: function(on) { midiEnabled = on; },
        getSynthEnabled: function() { return synthEnabled; },
        setSynthEnabled: function(on) { synthEnabled = on; },
        getMidiChannel: function() { return midiChannel; },
        setMidiChannel: function(ch) { allMidiNotesOff(); midiChannel = Math.max(0, Math.min(15, ch)); },
        isModelReady: function() { return modelReady; },
        onMidiDevicesChanged: function(cb) { onMidiDevicesChangedCb = cb; },
        _setPreloadedModel: setPreloadedModel
    };
})();
