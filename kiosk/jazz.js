/**
 * Seestar Jazz Engine — procedural jazz from telescope stacking data.
 *
 * Dual output: Web Audio API (built-in synth) + Web MIDI API (USB piano).
 * Synth uses Rhodes-like timbres, convolution reverb, chorus, and stereo panning.
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

    function buildChords(root, scale) {
        var s = scale.intervals;
        return {
            ii:  [s[1], s[3], s[5], s[1] + 12],
            V:   [s[4], s[6 % s.length] || s[0] + 10, s[1] + 12, s[3] + 12],
            I:   [0, s[2], s[4], s[6 % s.length] || s[0] + 11],
            iv:  [s[3], s[5], s[0] + 12, s[2] + 12]
        };
    }

    var PROGRESSION = ["ii", "V", "I", "I", "ii", "V", "I", "iv"];

    // ── Configuration ───────────────────────────────────────────
    var rootNote = 0;
    var scaleName = "dorian";
    var currentScale = SCALES.dorian;
    var currentChords = buildChords(0, SCALES.dorian);
    var BASE_MIDI = 48;

    // ── MIDI output ─────────────────────────────────────────────
    var midiAccess = null;
    var midiOutput = null;
    var midiEnabled = false;
    var midiChannel = 0;
    var midiDevices = [];
    var synthEnabled = true;
    var onMidiDevicesChanged = null;
    var activeMidiNotes = [];

    // ── Synth state ─────────────────────────────────────────────
    var ctx = null;
    var masterGain = null;
    var padGain = null;
    var bassGain = null;
    var melodyGain = null;
    var compressor = null;
    var reverbNode = null;     // ConvolverNode
    var reverbGain = null;     // wet mix
    var dryGain = null;        // dry mix
    var rhodesWave = null;     // custom PeriodicWave for Rhodes-like timbre
    var running = false;
    var volume = 0.5;

    var lastStacked = -1;
    var lastDropped = -1;
    var chordIndex = 0;
    var bassNoteIdx = 0;
    var bassInterval = null;
    var chordInterval = null;
    var currentState = "idle";
    var currentRA = 12;
    var currentDec = 0;
    var currentSNR = 5;
    var integrationSec = 0;

    // Image-driven state
    var starDensity = 0;       // 0–1 ratio of bright pixels
    var fillInterval = null;   // interval for ghost/fill notes
    var autoTonality = true;   // allow image to drive key/scale changes
    var suggestedKey = 0;
    var suggestedScale = "dorian";
    var lastKeyChange = 0;     // timestamp of last auto key change

    // ── Helpers ─────────────────────────────────────────────────

    function midiToFreq(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function scaleNote(index) {
        var s = currentScale.intervals;
        var oct = Math.floor(index / s.length);
        var deg = ((index % s.length) + s.length) % s.length;
        return rootNote + s[deg] + oct * 12;
    }

    function raToScaleIndex(ra) {
        var len = currentScale.intervals.length;
        return Math.floor((ra / 24) * len * 2);
    }

    function decToOctaveShift(dec) {
        if (dec > 30) return 1;
        if (dec < -30) return -1;
        return 0;
    }

    function snrToVelocity(snr) {
        return Math.min(1.0, Math.max(0.2, snr / 30));
    }

    function velocityToMidi(vel) {
        return Math.round(Math.min(127, Math.max(20, vel * 127)));
    }

    // ── Algorithmic reverb impulse response ─────────────────────
    // Generate a synthetic IR: exponential decay with early reflections

    function createReverbIR(duration, decay) {
        var len = Math.floor(ctx.sampleRate * duration);
        var buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (var ch = 0; ch < 2; ch++) {
            var data = buf.getChannelData(ch);
            for (var i = 0; i < len; i++) {
                var t = i / ctx.sampleRate;
                // Exponential decay + diffuse noise
                var env = Math.exp(-t * decay);
                // Early reflections: sparse impulses in first 80ms
                var early = 0;
                if (t < 0.08) {
                    var earlyTimes = [0.007, 0.013, 0.021, 0.034, 0.048, 0.063, 0.077];
                    for (var e = 0; e < earlyTimes.length; e++) {
                        if (Math.abs(t - earlyTimes[e]) < 0.001) {
                            early = 0.6 * (1 - t / 0.08);
                        }
                    }
                }
                data[i] = ((Math.random() * 2 - 1) * env * 0.5 + early) *
                           (1 + 0.1 * Math.sin(t * 2.3 * (ch + 1))); // slight stereo variation
            }
        }
        return buf;
    }

    // ── Rhodes-like PeriodicWave ─────────────────────────────────
    // Fender Rhodes: strong fundamental, bell-like upper partials, fast decay on highs

    function createRhodesWave() {
        var n = 16;
        var real = new Float32Array(n);
        var imag = new Float32Array(n);
        real[0] = 0;
        imag[0] = 0;
        // Harmonic amplitudes — Rhodes character:
        // strong 1st, moderate 2nd, bell-like 3rd, fast rolloff
        var harmonics = [0, 1.0, 0.4, 0.3, 0.15, 0.08, 0.12, 0.04, 0.06, 0.02, 0.03, 0.01, 0.02, 0.005, 0.008, 0.003];
        for (var i = 1; i < n; i++) {
            imag[i] = harmonics[i] || 0;
        }
        return ctx.createPeriodicWave(real, imag, {disableNormalization: false});
    }

    // ── MIDI output primitives ──────────────────────────────────

    function sendMidiNoteOn(note, velocity) {
        if (!midiOutput || !midiEnabled) return;
        var midiNote = Math.max(0, Math.min(127, note));
        midiOutput.send([0x90 | midiChannel, midiNote, velocityToMidi(velocity)]);
        activeMidiNotes.push({note: midiNote, time: Date.now()});
    }

    function sendMidiNoteOff(note) {
        if (!midiOutput || !midiEnabled) return;
        midiOutput.send([0x80 | midiChannel, Math.max(0, Math.min(127, note)), 0]);
    }

    function sendMidiNote(note, velocity, durationMs) {
        sendMidiNoteOn(note, velocity);
        setTimeout(function() { sendMidiNoteOff(note); }, durationMs);
    }

    function allMidiNotesOff() {
        if (!midiOutput) return;
        midiOutput.send([0xB0 | midiChannel, 123, 0]);
        activeMidiNotes = [];
    }

    // ── Synth: Rhodes-like note with ADSR + chorus + stereo ─────

    function playRhodes(freq, duration, velocity, dest, pan) {
        if (!ctx || !synthEnabled) return;
        var now = ctx.currentTime;

        // Stereo panner
        var panner = ctx.createStereoPanner();
        panner.pan.value = pan || 0;
        panner.connect(dest || melodyGain);

        // Two slightly detuned oscillators for chorus warmth
        for (var d = 0; d < 2; d++) {
            var osc = ctx.createOscillator();
            var g = ctx.createGain();
            var filter = ctx.createBiquadFilter();

            // Use Rhodes wave for main, slight detune for second
            osc.setPeriodicWave(rhodesWave);
            osc.frequency.value = freq * (1 + (d === 0 ? -0.0015 : 0.0015));

            // Subtle vibrato via LFO
            var lfo = ctx.createOscillator();
            var lfoGain = ctx.createGain();
            lfo.type = "sine";
            lfo.frequency.value = 4.5 + Math.random() * 1.5; // 4.5–6 Hz
            lfoGain.gain.value = freq * 0.003; // very subtle pitch wobble
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            lfo.start(now);
            lfo.stop(now + duration + 0.3);

            // Velocity-sensitive lowpass filter
            filter.type = "lowpass";
            filter.frequency.value = 1200 + velocity * 4000; // 1200–5200 Hz
            filter.Q.value = 0.8;
            // Filter envelope: bright attack, darker sustain
            filter.frequency.setValueAtTime(1200 + velocity * 5000, now);
            filter.frequency.exponentialRampToValueAtTime(800 + velocity * 2000, now + duration * 0.5);

            // ADSR envelope — exponential for natural piano feel
            var peak = velocity * 0.18;
            var sustain = peak * 0.35;
            g.gain.setValueAtTime(0, now);
            // Attack: fast (5ms)
            g.gain.linearRampToValueAtTime(peak, now + 0.005);
            // Decay: exponential to sustain (piano-like)
            g.gain.setTargetAtTime(sustain, now + 0.005, duration * 0.15);
            // Release: fade out
            g.gain.setTargetAtTime(0, now + duration * 0.8, 0.15);

            osc.connect(filter);
            filter.connect(g);
            g.connect(panner);

            osc.start(now);
            osc.stop(now + duration + 0.5);
        }
    }

    // ── Synth: warm pad (sine layers with slow attack) ──────────

    function playSynthPad(freq, duration, dest) {
        if (!ctx || !synthEnabled) return;
        var now = ctx.currentTime;
        // Two sine layers, slightly detuned, with slow swell
        for (var d = 0; d < 2; d++) {
            var osc = ctx.createOscillator();
            var g = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq * (1 + (d === 0 ? -0.002 : 0.002));
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(0.05, now + 1.2);
            g.gain.setValueAtTime(0.05, now + duration * 0.6);
            g.gain.setTargetAtTime(0, now + duration * 0.7, 0.5);
            osc.connect(g);
            g.connect(dest || padGain);
            osc.start(now);
            osc.stop(now + duration + 1);
        }
    }

    // ── Synth: bass (triangle + sub-sine, warm) ─────────────────

    function playSynthBass(freq, duration, velocity, dest) {
        if (!ctx || !synthEnabled) return;
        var now = ctx.currentTime;
        var panner = ctx.createStereoPanner();
        panner.pan.value = -0.2; // bass slightly left

        // Main: triangle
        var osc1 = ctx.createOscillator();
        var g1 = ctx.createGain();
        var filt = ctx.createBiquadFilter();
        osc1.type = "triangle";
        osc1.frequency.value = freq;
        filt.type = "lowpass";
        filt.frequency.value = 600;
        filt.Q.value = 1.5;
        var peak = velocity * 0.25;
        g1.gain.setValueAtTime(0, now);
        g1.gain.linearRampToValueAtTime(peak, now + 0.01);
        g1.gain.setTargetAtTime(peak * 0.5, now + 0.01, duration * 0.2);
        g1.gain.setTargetAtTime(0, now + duration * 0.7, 0.1);
        osc1.connect(filt);
        filt.connect(g1);
        g1.connect(panner);
        osc1.start(now);
        osc1.stop(now + duration + 0.3);

        // Sub: sine one octave lower
        var osc2 = ctx.createOscillator();
        var g2 = ctx.createGain();
        osc2.type = "sine";
        osc2.frequency.value = freq / 2;
        g2.gain.setValueAtTime(0, now);
        g2.gain.linearRampToValueAtTime(peak * 0.4, now + 0.015);
        g2.gain.setTargetAtTime(0, now + duration * 0.5, 0.15);
        osc2.connect(g2);
        g2.connect(panner);
        osc2.start(now);
        osc2.stop(now + duration + 0.3);

        panner.connect(dest || bassGain);
    }

    // ── Composite note (synth + MIDI) ───────────────────────────

    function noteOnRhodes(midiNote, velocity, durationSec, dest, pan) {
        if (synthEnabled && ctx) {
            playRhodes(midiToFreq(midiNote), durationSec, velocity, dest, pan);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(midiNote, velocity, Math.round(durationSec * 1000));
        }
    }

    // ── Musical functions ───────────────────────────────────────

    function playChord(chordName, duration) {
        if (!running) return;
        var intervals = currentChords[chordName] || currentChords["I"];
        intervals.forEach(function(semi, i) {
            var midiNote = BASE_MIDI + semi;
            if (synthEnabled && ctx) {
                playSynthPad(midiToFreq(midiNote), duration, padGain);
            }
            if (midiEnabled && midiOutput) {
                sendMidiNote(midiNote, 0.25, Math.round(duration * 1000));
            }
        });
    }

    function playBassNote(semi) {
        if (!running) return;
        var midiNote = BASE_MIDI - 12 + semi;
        if (synthEnabled && ctx) {
            playSynthBass(midiToFreq(midiNote), 0.6, 0.5, bassGain);
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(midiNote, 0.5, 600);
        }
    }

    function playMelodyNote(ra, dec, snr) {
        var idx = raToScaleIndex(ra);
        var octShift = decToOctaveShift(dec);
        var semi = scaleNote(idx) + (octShift * 12);
        var midiNote = BASE_MIDI + 12 + semi;
        var vel = snrToVelocity(snr);
        var dur = Math.min(2.0, 0.4 + integrationSec / 600);
        // Slight random pan for spatial interest
        var pan = (Math.random() - 0.5) * 0.6;
        noteOnRhodes(midiNote, vel, dur, melodyGain, pan);
    }

    function playDissonance() {
        if (!running) return;
        var semi = Math.floor(Math.random() * 12);
        var midiNote1 = BASE_MIDI + 12 + rootNote + semi;
        var midiNote2 = midiNote1 + 1;
        // Short, harsh — use raw oscillators even in improved synth
        if (synthEnabled && ctx) {
            var now = ctx.currentTime;
            for (var n = 0; n < 2; n++) {
                var osc = ctx.createOscillator();
                var g = ctx.createGain();
                osc.type = "sawtooth";
                osc.frequency.value = midiToFreq(n === 0 ? midiNote1 : midiNote2);
                var v = n === 0 ? 0.12 : 0.08;
                g.gain.setValueAtTime(v, now);
                g.gain.setTargetAtTime(0, now + 0.02, 0.05);
                osc.connect(g);
                g.connect(melodyGain);
                osc.start(now);
                osc.stop(now + 0.2);
            }
        }
        if (midiEnabled && midiOutput) {
            sendMidiNote(midiNote1, 0.2, 150);
            sendMidiNote(midiNote2, 0.15, 150);
        }
    }

    // ── Loops ───────────────────────────────────────────────────

    function startBassWalk() {
        if (bassInterval) return;
        bassNoteIdx = 0;
        bassInterval = setInterval(function() {
            if (!running) return;
            var chord = currentChords[PROGRESSION[chordIndex]];
            var target = chord[bassNoteIdx % chord.length];
            if (Math.random() < 0.25) {
                target += (Math.random() < 0.5 ? 1 : -1);
            }
            playBassNote(target);
            bassNoteIdx++;
            if (bassNoteIdx >= 4) bassNoteIdx = 0;
        }, currentState === "slewing" ? 400 : 700);
    }

    function startChordChanges() {
        if (chordInterval) return;
        playChord(PROGRESSION[chordIndex], 5.5);
        chordInterval = setInterval(function() {
            if (!running) return;
            chordIndex = (chordIndex + 1) % PROGRESSION.length;
            playChord(PROGRESSION[chordIndex], 5.5);
        }, 5600);
    }

    function stopLoops() {
        if (bassInterval) { clearInterval(bassInterval); bassInterval = null; }
        if (chordInterval) { clearInterval(chordInterval); chordInterval = null; }
        if (fillInterval) { clearInterval(fillInterval); fillInterval = null; }
        allMidiNotesOff();
    }

    // ── Fill notes (ghost notes driven by star density) ─────────
    // More stars → more frequent fill notes between stack triggers

    function playFillNote() {
        if (!running || currentState === "idle") return;
        // Pick a random scale degree, quiet ghost note
        var s = currentScale.intervals;
        var deg = Math.floor(Math.random() * s.length);
        var octShift = Math.floor(Math.random() * 2); // 0 or 1 octave up
        var semi = rootNote + s[deg] + octShift * 12;
        var midiNote = BASE_MIDI + 12 + semi;
        var vel = 0.1 + Math.random() * 0.15; // quiet: 0.1–0.25
        var dur = 0.2 + Math.random() * 0.3;  // short: 0.2–0.5s
        var pan = (Math.random() - 0.5) * 0.8;
        noteOnRhodes(midiNote, vel, dur, melodyGain, pan);
    }

    function updateFillRate() {
        if (fillInterval) { clearInterval(fillInterval); fillInterval = null; }
        if (!running) return;
        // starDensity 0–1:
        // < 0.005 → no fills
        // 0.005–0.02 → one fill every 6s
        // 0.02–0.05 → every 3s
        // 0.05–0.10 → every 1.5s
        // > 0.10 → every 0.8s (busy sky)
        var interval;
        if (starDensity < 0.005) return; // too few stars, silence
        else if (starDensity < 0.02) interval = 6000;
        else if (starDensity < 0.05) interval = 3000;
        else if (starDensity < 0.10) interval = 1500;
        else interval = 800;
        fillInterval = setInterval(playFillNote, interval);
    }

    // ── Image-driven tonality ───────────────────────────────────

    function setStarDensity(ratio) {
        starDensity = Math.max(0, Math.min(1, ratio));
        updateFillRate();
    }

    function suggestKey(newKey) {
        if (!autoTonality) return;
        if (newKey === rootNote) return;
        // Don't change key more often than every 30s
        var now = Date.now();
        if (now - lastKeyChange < 30000) return;
        lastKeyChange = now;
        rootNote = newKey % 12;
        currentChords = buildChords(rootNote, currentScale);
        if (running) {
            // Smooth transition: let current chord finish, restart on next cycle
            stopLoops();
            chordIndex = 0;
            startChordChanges();
            startBassWalk();
            updateFillRate();
        }
    }

    function suggestScale(name) {
        if (!autoTonality) return;
        if (!SCALES[name] || name === scaleName) return;
        scaleName = name;
        currentScale = SCALES[name];
        currentChords = buildChords(rootNote, currentScale);
        if (running) {
            stopLoops();
            chordIndex = 0;
            startChordChanges();
            startBassWalk();
            updateFillRate();
        }
    }

    function setAutoTonality(on) { autoTonality = on; }
    function getAutoTonality() { return autoTonality; }

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
        if (!navigator.requestMIDIAccess) {
            console.warn("Web MIDI API not available");
            return Promise.resolve(false);
        }
        return navigator.requestMIDIAccess({sysex: false}).then(function(access) {
            midiAccess = access;
            refreshMidiDevices();
            midiAccess.onstatechange = function() { refreshMidiDevices(); };
            if (!midiOutput && midiDevices.length > 0) {
                selectMidiDevice(midiDevices[0].id);
            }
            return true;
        }).catch(function(err) {
            console.warn("MIDI access denied:", err);
            return false;
        });
    }

    function selectMidiDevice(deviceId) {
        if (!midiAccess) return false;
        allMidiNotesOff();
        var out = midiAccess.outputs.get(deviceId);
        if (out) { midiOutput = out; midiEnabled = true; return true; }
        return false;
    }

    // ── Init ────────────────────────────────────────────────────

    function initSynth() {
        if (ctx) return;
        ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Compressor → destination
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 12;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;
        compressor.connect(ctx.destination);

        // Reverb: dry/wet mix → compressor
        reverbNode = ctx.createConvolver();
        reverbNode.buffer = createReverbIR(2.5, 3.0);

        reverbGain = ctx.createGain();
        reverbGain.gain.value = 0.35; // wet
        reverbNode.connect(reverbGain);
        reverbGain.connect(compressor);

        dryGain = ctx.createGain();
        dryGain.gain.value = 0.75; // dry
        dryGain.connect(compressor);

        // Master → dry + reverb send
        masterGain = ctx.createGain();
        masterGain.gain.value = volume;
        masterGain.connect(dryGain);
        masterGain.connect(reverbNode);

        padGain = ctx.createGain();
        padGain.gain.value = 0.5;
        padGain.connect(masterGain);

        bassGain = ctx.createGain();
        bassGain.gain.value = 0.6;
        bassGain.connect(masterGain);

        melodyGain = ctx.createGain();
        melodyGain.gain.value = 0.8;
        melodyGain.connect(masterGain);

        // Rhodes-like custom waveform
        rhodesWave = createRhodesWave();
    }

    function start() {
        initSynth();
        initMidi();
        if (ctx.state === "suspended") ctx.resume();
        running = true;
        startChordChanges();
        startBassWalk();
        updateFillRate();
    }

    function stop() {
        running = false;
        stopLoops();
    }

    function toggle() {
        if (running) { stop(); return false; }
        else { start(); return true; }
    }

    function setKey(noteIndex) {
        rootNote = noteIndex % 12;
        currentChords = buildChords(rootNote, currentScale);
        if (running) { stopLoops(); chordIndex = 0; startChordChanges(); startBassWalk(); }
    }

    function setScale(name) {
        if (!SCALES[name]) return;
        scaleName = name;
        currentScale = SCALES[name];
        currentChords = buildChords(rootNote, currentScale);
        if (running) { stopLoops(); chordIndex = 0; startChordChanges(); startBassWalk(); }
    }

    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        if (masterGain) masterGain.gain.value = volume;
    }

    function setReverb(wet) {
        if (reverbGain) reverbGain.gain.value = Math.max(0, Math.min(1, wet));
        if (dryGain) dryGain.gain.value = Math.max(0, Math.min(1, 1 - wet * 0.5));
    }

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

    // ── Feed ────────────────────────────────────────────────────

    function feed(data) {
        if (!running) return;

        if (data.state && data.state !== currentState) {
            currentState = data.state;
            if (bassInterval) { clearInterval(bassInterval); bassInterval = null; startBassWalk(); }
            if (currentState === "idle") {
                if (bassGain) bassGain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 1);
                if (melodyGain) melodyGain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 1);
            } else {
                if (bassGain) bassGain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.5);
                if (melodyGain) melodyGain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.5);
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

        if (data.stats && data.stats.stacked_frame != null) {
            var stacked = parseInt(data.stats.stacked_frame);
            if (lastStacked >= 0 && stacked > lastStacked) {
                playMelodyNote(currentRA, currentDec, currentSNR);
            }
            lastStacked = stacked;
        }

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
        onMidiDevicesChanged: function(cb) { onMidiDevicesChanged = cb; }
    };
})();
