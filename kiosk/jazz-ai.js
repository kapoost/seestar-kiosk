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

var SeestarJazz = (function() {
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

    // Chord symbols for Magenta chord conditioning
    var CHORD_SYMBOLS = {
        ii:  "Dm",  V: "G7", I: "Cmaj7", iv: "Fm"
    };

    // Build chord symbols transposed to current key
    function chordForKey(chordDeg, key) {
        var base = {
            ii:  [2, "m7"],
            V:   [7, "7"],
            I:   [0, "maj7"],
            iv:  [5, "m7"]
        };
        var b = base[chordDeg];
        if (!b) return "C";
        var noteIdx = (key + b[0]) % 12;
        return NOTE_NAMES[noteIdx] + b[1];
    }

    var PROGRESSION = ["ii", "V", "I", "I", "ii", "V", "I", "iv"];

    // ── Configuration ───────────────────────────────────────────
    var rootNote = 0;
    var scaleName = "dorian";
    var currentScale = SCALES.dorian;
    var BASE_MIDI = 60; // C4 for melody

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
    var suggestedKey = 0;
    var lastKeyChange = 0;

    // ── Magenta ─────────────────────────────────────────────────
    var rnn = null;
    var CHECKPOINT_URL = "https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/chord_pitches_improv";
    var isGenerating = false;
    var lastSeed = null; // last generated NoteSequence for chaining

    // ── Tone.js instruments ─────────────────────────────────────
    var melodySynth = null;
    var padSynth = null;
    var bassSynth = null;
    var reverb = null;
    var chorus = null;
    var masterVol = null;
    var toneStarted = false;

    // ── MIDI output ─────────────────────────────────────────────
    var midiAccess = null;
    var midiOutput = null;
    var midiEnabled = false;
    var midiChannel = 0;
    var midiDevices = [];
    var synthEnabled = true;
    var onMidiDevicesChanged = null;

    // ── Loops ───────────────────────────────────────────────────
    var chordLoop = null;
    var bassLoop = null;
    var fillLoop = null;
    var bassNoteIdx = 0;

    // ── Helpers ─────────────────────────────────────────────────

    function midiToNote(midi) {
        var names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
        var oct = Math.floor(midi / 12) - 1;
        return names[midi % 12] + oct;
    }

    function scaleNote(index) {
        var s = currentScale.intervals;
        var oct = Math.floor(index / s.length);
        var deg = ((index % s.length) + s.length) % s.length;
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
        // Low SNR → conservative (0.6), high SNR → adventurous (1.4)
        return Math.min(1.4, Math.max(0.6, 0.6 + (snr / 30) * 0.8));
    }

    function densityToSteps(density) {
        // More stars → longer phrases
        if (density < 0.005) return 4;
        if (density < 0.02) return 8;
        if (density < 0.05) return 16;
        if (density < 0.10) return 24;
        return 32;
    }

    function currentChordSymbol() {
        return chordForKey(PROGRESSION[chordIndex], rootNote);
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
        if (onMidiDevicesChanged) onMidiDevicesChanged(midiDevices);
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

    function initTone() {
        if (melodySynth) return;

        masterVol = new Tone.Volume(Tone.gainToDb(volume)).toDestination();

        reverb = new Tone.Reverb({decay: 3, wet: 0.35}).connect(masterVol);
        chorus = new Tone.Chorus({frequency: 1.5, delayTime: 3.5, depth: 0.5, wet: 0.3}).connect(reverb);

        // Rhodes-like FM synth for melody
        melodySynth = new Tone.PolySynth(Tone.FMSynth, {
            maxPolyphony: 8,
            voice0: {
                harmonicity: 3.01,
                modulationIndex: 14,
                oscillator: {type: "triangle"},
                envelope: {attack: 0.005, decay: 0.4, sustain: 0.2, release: 1.2},
                modulation: {type: "square"},
                modulationEnvelope: {attack: 0.002, decay: 0.2, sustain: 0, release: 0.5}
            }
        }).connect(chorus);

        // Warm pad
        padSynth = new Tone.PolySynth(Tone.Synth, {
            maxPolyphony: 8,
            voice0: {
                oscillator: {type: "sine"},
                envelope: {attack: 1.2, decay: 2, sustain: 0.3, release: 2}
            }
        }).connect(reverb);
        padSynth.volume.value = -12;

        // Bass
        bassSynth = new Tone.MonoSynth({
            oscillator: {type: "triangle"},
            filter: {type: "lowpass", frequency: 600, Q: 2},
            envelope: {attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3},
            filterEnvelope: {attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.3, baseFrequency: 200, octaves: 2}
        }).connect(reverb);
        bassSynth.volume.value = -6;
    }

    async function startTone() {
        if (!toneStarted) {
            await Tone.start();
            toneStarted = true;
        }
    }

    // ── Magenta model ───────────────────────────────────────────

    async function loadModel() {
        if (modelReady || modelLoading) return;
        modelLoading = true;
        try {
            rnn = new mm.MusicRNN(CHECKPOINT_URL);
            await rnn.initialize();
            modelReady = true;
            console.log("[jazz-ai] MusicRNN loaded");
        } catch(e) {
            console.error("[jazz-ai] Model load failed:", e);
            modelReady = false;
        }
        modelLoading = false;
    }

    // ── Seed builder ────────────────────────────────────────────
    // Build a short NoteSequence seed from current telescope data

    function buildSeed(ra, dec, snr) {
        var idx = raToScaleIndex(ra);
        var octShift = decToOctaveShift(dec);
        var notes = [];
        var qpm = currentState === "slewing" ? 140 : 90;
        var stepsPerQ = 4;

        // 4-note seed from current position
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
            tempos: [{time: 0, qpm: qpm}]
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
            var chord = currentChordSymbol();

            // Build chord progression for the generated phrase
            var chordSteps = [];
            var stepsPerChord = Math.max(4, Math.floor(steps / 4));
            for (var c = 0; c < 4; c++) {
                var ci = (chordIndex + c) % PROGRESSION.length;
                chordSteps.push(chordForKey(PROGRESSION[ci], rootNote));
            }

            var result = await rnn.continueSequence(
                seed,
                steps,
                temperature,
                chordSteps
            );

            // Play the generated notes via Tone.js and/or MIDI
            if (result && result.notes && result.notes.length > 0) {
                playSequence(result);
                // Chain: use end of this sequence as next seed
                var seedNotes = result.notes.slice(-4);
                if (seedNotes.length >= 2) {
                    // Renumber steps to start at 0
                    var minStep = seedNotes[0].quantizedStartStep;
                    lastSeed = {
                        notes: seedNotes.map(function(n) {
                            return {
                                pitch: n.pitch,
                                quantizedStartStep: n.quantizedStartStep - minStep,
                                quantizedEndStep: n.quantizedEndStep - minStep
                            };
                        }),
                        quantizationInfo: result.quantizationInfo,
                        totalQuantizedSteps: seedNotes[seedNotes.length - 1].quantizedEndStep - minStep,
                        tempos: result.tempos
                    };
                }
            }
        } catch(e) {
            console.warn("[jazz-ai] Generation error:", e);
        }

        isGenerating = false;
    }

    function playSequence(seq) {
        if (!seq || !seq.notes) return;
        var qpm = (seq.tempos && seq.tempos[0]) ? seq.tempos[0].qpm : 90;
        var secPerStep = 60 / (qpm * (seq.quantizationInfo ? seq.quantizationInfo.stepsPerQuarter : 4));
        var now = Tone.now();

        seq.notes.forEach(function(note) {
            var startTime = now + note.quantizedStartStep * secPerStep;
            var duration = (note.quantizedEndStep - note.quantizedStartStep) * secPerStep;
            duration = Math.max(0.1, duration);
            var noteName = midiToNote(note.pitch);
            var velocity = 0.3 + Math.random() * 0.4; // 0.3–0.7, natural variation

            // Tone.js synth
            if (synthEnabled && melodySynth) {
                melodySynth.triggerAttackRelease(noteName, duration, startTime, velocity);
            }

            // MIDI out
            if (midiEnabled && midiOutput) {
                var delayMs = (startTime - Tone.now()) * 1000;
                if (delayMs < 0) delayMs = 0;
                setTimeout(function() {
                    sendMidiNote(note.pitch, velocity, duration * 1000);
                }, delayMs);
            }
        });

        // Advance chord index
        chordIndex = (chordIndex + 4) % PROGRESSION.length;
    }

    // ── Background loops (bass + pad + fills) ───────────────────

    function startBassWalk() {
        if (bassLoop) return;
        bassNoteIdx = 0;

        // Build bass notes from current scale
        function getBassNote() {
            var s = currentScale.intervals;
            var deg = bassNoteIdx % s.length;
            var semi = rootNote + s[deg];
            // Chromatic approach sometimes
            if (Math.random() < 0.2) semi += (Math.random() < 0.5 ? 1 : -1);
            return semi + 36; // C2 range
        }

        var interval = currentState === "slewing" ? 0.4 : 0.7;
        bassLoop = new Tone.Loop(function(time) {
            if (!running) return;
            var midi = getBassNote();
            var noteName = midiToNote(midi);
            if (synthEnabled && bassSynth) {
                bassSynth.triggerAttackRelease(noteName, "8n", time, 0.6);
            }
            if (midiEnabled && midiOutput) {
                sendMidiNote(midi, 0.5, 500);
            }
            bassNoteIdx++;
        }, interval).start(0);
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
                padSynth.triggerAttackRelease(notes, "2n", time, 0.15);
            }
        }, "1m").start(0);
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
            var oct = Math.floor(Math.random() * 2);
            var midi = BASE_MIDI + rootNote + s[deg] + oct * 12;
            var noteName = midiToNote(midi);
            var vel = 0.1 + Math.random() * 0.15;
            if (synthEnabled && melodySynth) {
                melodySynth.triggerAttackRelease(noteName, "16n", time, vel);
            }
            if (midiEnabled && midiOutput) {
                sendMidiNote(midi, vel, 200);
            }
        }, interval).start(0);
    }

    function stopLoops() {
        if (bassLoop) { bassLoop.stop(); bassLoop.dispose(); bassLoop = null; }
        if (chordLoop) { chordLoop.stop(); chordLoop.dispose(); chordLoop = null; }
        if (fillLoop) { fillLoop.stop(); fillLoop.dispose(); fillLoop = null; }
        Tone.Transport.stop();
        Tone.Transport.cancel();
        allMidiNotesOff();
    }

    // ── Dissonance (dropped frame) ──────────────────────────────

    function playDissonance() {
        if (!running) return;
        var semi = Math.floor(Math.random() * 12);
        var n1 = BASE_MIDI + rootNote + semi;
        var n2 = n1 + 1;
        if (synthEnabled && melodySynth) {
            melodySynth.triggerAttackRelease(midiToNote(n1), "32n", undefined, 0.3);
            melodySynth.triggerAttackRelease(midiToNote(n2), "32n", "+0.02", 0.2);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(n1, 0.2, 100);
            sendMidiNote(n2, 0.15, 100);
        }
    }

    // ── Public API ──────────────────────────────────────────────

    async function start() {
        initTone();
        await startTone();
        initMidi();
        loadModel(); // async, non-blocking — procedural fallback until ready

        running = true;
        Tone.Transport.bpm.value = currentState === "slewing" ? 140 : 90;
        Tone.Transport.start();
        startBassWalk();
        startChordPad();
        startFillNotes();
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
        if (running) { stopLoops(); chordIndex = 0; Tone.Transport.start(); startBassWalk(); startChordPad(); startFillNotes(); }
        lastSeed = null;
    }

    function setScale(name) {
        if (!SCALES[name]) return;
        scaleName = name;
        currentScale = SCALES[name];
        if (running) { stopLoops(); chordIndex = 0; Tone.Transport.start(); startBassWalk(); startChordPad(); startFillNotes(); }
        lastSeed = null;
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

    function suggestKey(newKey) {
        if (!autoTonality || newKey === rootNote) return;
        if (Date.now() - lastKeyChange < 30000) return;
        lastKeyChange = Date.now();
        rootNote = newKey % 12;
        lastSeed = null;
        if (running) { stopLoops(); chordIndex = 0; Tone.Transport.start(); startBassWalk(); startChordPad(); startFillNotes(); }
    }

    function suggestScale(name) {
        if (!autoTonality || !SCALES[name] || name === scaleName) return;
        scaleName = name;
        currentScale = SCALES[name];
        lastSeed = null;
        if (running) { stopLoops(); chordIndex = 0; Tone.Transport.start(); startBassWalk(); startChordPad(); startFillNotes(); }
    }

    function setAutoTonality(on) { autoTonality = on; }
    function getAutoTonality() { return autoTonality; }
    function setSynthEnabled(on) { synthEnabled = on; }
    function setMidiEnabled(on) { midiEnabled = on; }
    function setMidiChannel(ch) { allMidiNotesOff(); midiChannel = Math.max(0, Math.min(15, ch)); }

    function getVolume() { return volume; }
    function isRunning() { return running; }
    function getKey() { return rootNote; }
    function getKeyName() { return NOTE_NAMES[rootNote]; }
    function getScaleName() { return scaleName; }
    function getScaleDisplayName() { return currentScale.name; }
    function getMidiDevices() { return midiDevices; }
    function getMidiEnabled() { return midiEnabled; }
    function getSynthEnabled() { return synthEnabled; }
    function getMidiChannel() { return midiChannel; }
    function getNoteNames() { return NOTE_NAMES; }
    function getScales() { return SCALES; }
    function isModelReady() { return modelReady; }

    // ── Feed ────────────────────────────────────────────────────

    function feed(data) {
        if (!running) return;

        if (data.state && data.state !== currentState) {
            currentState = data.state;
            var bpm = currentState === "slewing" ? 140 : 90;
            Tone.Transport.bpm.rampTo(bpm, 2);
            // Restart bass with new tempo
            if (bassLoop) { bassLoop.stop(); bassLoop.dispose(); bassLoop = null; }
            startBassWalk();

            if (currentState === "idle") {
                if (padSynth) padSynth.volume.rampTo(-24, 2);
                if (bassSynth) bassSynth.volume.rampTo(-18, 2);
            } else {
                if (padSynth) padSynth.volume.rampTo(-12, 1);
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

        // New stack → trigger AI generation or procedural fallback
        if (data.stats && data.stats.stacked_frame != null) {
            var stacked = parseInt(data.stats.stacked_frame);
            if (lastStacked >= 0 && stacked > lastStacked) {
                if (modelReady && !isGenerating) {
                    generateAndPlay();
                } else {
                    // Procedural fallback: single note
                    playProceduralNote();
                }
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

    // Procedural fallback when model not yet loaded
    function playProceduralNote() {
        var idx = raToScaleIndex(currentRA);
        var octShift = decToOctaveShift(currentDec);
        var semi = scaleNote(idx) + (octShift * 12);
        var midi = BASE_MIDI + semi;
        midi = Math.max(48, Math.min(84, midi));
        var noteName = midiToNote(midi);
        var vel = Math.min(1, Math.max(0.2, currentSNR / 30));
        var dur = Math.min(2, 0.4 + integrationSec / 600);

        if (synthEnabled && melodySynth) {
            melodySynth.triggerAttackRelease(noteName, dur, undefined, vel);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(midi, vel, dur * 1000);
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

    return {
        toggle: toggle, start: start, stop: stop,
        feed: feed, feedOverlay: feedOverlay,
        setVolume: setVolume, getVolume: getVolume, isRunning: isRunning,
        setReverb: setReverb,
        setStarDensity: setStarDensity,
        suggestKey: suggestKey, suggestScale: suggestScale,
        setAutoTonality: setAutoTonality, getAutoTonality: getAutoTonality,
        setKey: setKey, setScale: setScale,
        getKey: getKey, getKeyName: getKeyName,
        getScaleName: getScaleName, getScaleDisplayName: getScaleDisplayName,
        getNoteNames: getNoteNames, getScales: getScales,
        initMidi: initMidi, selectMidiDevice: selectMidiDevice,
        getMidiDevices: getMidiDevices, getMidiEnabled: getMidiEnabled,
        setMidiEnabled: setMidiEnabled, getSynthEnabled: getSynthEnabled,
        setSynthEnabled: setSynthEnabled, getMidiChannel: getMidiChannel,
        setMidiChannel: setMidiChannel,
        isModelReady: isModelReady,
        onMidiDevicesChanged: function(cb) { onMidiDevicesChanged = cb; }
    };
})();
