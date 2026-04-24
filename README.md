# Seestar Kiosk

Full-screen, dark-adapted live view from a ZWO Seestar S30 Pro telescope — designed for projector displays at star parties and public outreach.

Includes a jazz engine that turns real-time telescope telemetry into music: stacking frames trigger melody notes, star density controls note frequency, and image colors shift the key and scale.

![Day mode](https://img.shields.io/badge/mode-day%20%2F%20night-blue)
![Offline](https://img.shields.io/badge/works-fully%20offline-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

### Telescope control
- **Live view** — MJPEG stream with auto-reconnect, crop/contain toggle
- **Object catalog** — Messier & NGC/IC with search and type filters, one-click GoTo
- **Stacking** — start/stop, exposure (10–120s), gain control
- **Scenery mode** — daytime photo mode for landscapes
- **Video recording** — AVI capture with optional timelapse, synchronized audio export
- **Pilot** — D-pad manual slew, zoom (1×/2×/4×), tracking, auto-focus, plate solve
- **Mount modes** — switch between alt-azimuth and equatorial (parallactic) with guided instructions

### Wide-angle camera
- **Picture-in-Picture** — finder camera overlay (RTSP→MJPEG proxy)
- **FOV rectangle** — shows main telescope field of view on the wide image
- **Click-to-slew** — click anywhere on the wide PiP to move the telescope there
- **Health monitoring** — auto-detects stream disconnection, shows RECONNECTING/OFFLINE status

### Jazz engine
- **Two engines** — procedural (Web Audio) and AI (Magenta MusicRNN), switchable at runtime
- **Salamander Grand Piano** — 30-sample Yamaha C5 concert grand, loaded locally
- **Telescope-driven music** — every parameter maps from live data:

| Telescope data | Music parameter |
|---------------|-----------------|
| New stacked frame | Melody note triggered |
| RA (0–24h) | Pitch / scale degree |
| Dec (-90°–+90°) | Octave shift |
| SNR | Velocity (louder = cleaner signal) |
| Dropped frame | Dissonant grace note |
| Star density | Ghost note rate (more stars = more notes) |
| Dominant hue | Key (color wheel → circle of fifths) |
| Color diversity | Scale complexity (pentatonic → diminished) |
| Color diversity | Octave range (monochrome = 2 oct, rainbow = full piano) |
| Telescope state | Ensemble feel (working → full, slewing → tension, idle → ambient) |
| Integration time | Note duration (longer exposure = longer sustain) |

- **12 keys × 9 scales** — manual or auto-tonality from image analysis
- **MIDI output** — Web MIDI API, auto-detects Roland/Casio USB pianos, dual synth+MIDI output
- **Audio recording** — captures jazz output as WebM during video recording for post-production sync

### AI engine (MusicRNN)
- **Magenta chord_pitches_improv** model — generates jazz phrases conditioned on chord progressions
- **Continuous generation** — plays non-stop, chaining phrases by using the tail of each sequence as the next seed
- **Telescope-seeded** — RA/Dec/SNR create the initial seed, new stack frames refresh it
- **Temperature from SNR** — low signal = conservative melodies, high signal = adventurous improvisation
- **Fully offline** — TensorFlow.js, model weights, and all libraries bundled locally (~8.7MB)

### Display
- **Night mode** — red-on-black, preserves dark adaptation
- **Day mode** — blue-on-white for daytime use
- **Dual panel** — control panel (left) + jazz panel (right), open together with `P`
- **Quit confirmation** — prevents accidental closure

## Requirements

- macOS (tested on Sonoma/Sequoia)
- Python 3.11+ (`brew install python@3.11`)
- Google Chrome
- ZWO Seestar S30 Pro in Station mode (same Wi-Fi network)
- HDMI projector (optional — works on a single screen)
- USB digital piano for MIDI output (optional — built-in Salamander piano works standalone)

## Quick start

```bash
# 1. Clone this repo
git clone https://github.com/kapoost/seestar-kiosk.git
cd seestar-kiosk

# 2. Clone the Alpaca proxy dependency
git clone https://github.com/smart-underworld/seestar_alp.git vendor/seestar_alp

# 3. Set up Python environment
python3.11 -m venv .venv
.venv/bin/pip install -r vendor/seestar_alp/requirements.txt
.venv/bin/pip install flask flask-cors opencv-python-headless waitress

# 4. Download offline assets (piano samples, AI model, JS libraries)
# These are included in kiosk/lib/ — no internet needed at runtime

# 5. Copy and edit config
cp config.sh.example config.sh
# Set SEESTAR_IP if auto-discovery doesn't work

# 6. Launch
./kiosk/launcher.sh
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Q` / `Esc` | Quit (with confirmation) |
| `P` | Toggle control + jazz panels |
| `F` | Toggle status overlay |
| `C` | Crop / contain live image |
| `W` | Wide-angle PiP |
| `D` | Day / Night mode |
| `J` | Jazz on / off |
| `H` | Help overlay |

## Architecture

```
kiosk/
├── launcher.sh        Orchestrator: discovery → ALP → proxy → HTTP → Chrome
├── kiosk.html         Fullscreen kiosk UI (stream + controls + jazz)
├── kiosk.css          Dark-adapted styling with night/day modes
├── jazz.js            Procedural jazz engine (Web Audio API + Web MIDI)
├── jazz-ai.js         AI jazz engine (Magenta MusicRNN + Tone.js)
├── catalog.js         Messier + NGC/IC object catalog
├── wide_proxy.py      RTSP→MJPEG proxy for wide-angle finder camera
├── discover.py        Seestar IP discovery (mDNS / UDP / ARP)
└── lib/
    ├── tf.min.js              TensorFlow.js (1.4MB)
    ├── Tone.min.js            Tone.js synth framework (343KB)
    ├── magenta-core.js        Magenta core (236KB)
    ├── magenta-music-rnn.js   MusicRNN module (152KB)
    ├── magenta-model/         chord_pitches_improv checkpoint (5.3MB)
    │   ├── config.json
    │   ├── weights_manifest.json
    │   ├── group1-shard1of2
    │   └── group1-shard2of2
    └── salamander/            Yamaha C5 grand piano samples (1.2MB)
        ├── A0.mp3 ... C8.mp3  30 samples, every 3 semitones

config.sh.example      Configuration template
config.sh              User config (gitignored)
vendor/seestar_alp/    Alpaca proxy for Seestar (cloned dependency)
```

### Data flow

```
Seestar S30 Pro (Wi-Fi)
  │
  ├── TCP:4700 ──→ seestar_alp ──→ :5555 Alpaca REST API ──→ kiosk.html
  │                               └→ :7556 MJPEG stream    ──→ <img> live view
  │                               └→ :7556 SSE status      ──→ jazz engine feed()
  │
  └── RTSP:4555 ─→ wide_proxy.py ─→ :7557 MJPEG ──→ <img> wide PiP
                                   └→ :7557/health ──→ connection monitor

kiosk.html (:8888 local HTTP)
  ├── Image analysis (canvas) ──→ star density, hue, entropy
  │                              └→ jazz: key, scale, octave range, note density
  ├── SSE telemetry ──→ jazz: RA→pitch, Dec→octave, SNR→velocity
  ├── Jazz engine ──→ Web Audio (Salamander piano + pad + bass)
  │               └→ Web MIDI (USB piano)
  └── MediaRecorder ──→ .webm audio file (during video REC)
```

## Configuration

Copy `config.sh.example` to `config.sh` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEESTAR_IP` | (auto) | Telescope IP; leave empty for mDNS discovery |
| `ALPACA_PORT` | 5555 | seestar_alp Alpaca API port |
| `IMG_PORT` | 7556 | MJPEG stream port |
| `WIDE_PORT` | 7557 | Wide-angle proxy port |
| `DEVICE_NUM` | 1 | Seestar device number |
| `INTEROP_PEM` | `~/.seestar/interop.pem` | Authentication key for firmware 7.18+ |
| `VENV_PATH` | `.venv` | Python virtual environment path |
| `SEESTAR_ALP_PATH` | `vendor/seestar_alp` | Path to seestar_alp |

## Mount modes

The Seestar S30 Pro supports two tracking modes:

- **Alt-Azimuth** (default) — simple setup, field rotation over time
- **Equatorial** — requires a wedge aligned to celestial pole, eliminates field rotation

Switching modes parks the telescope. The kiosk shows a full-screen instruction overlay guiding you through the physical setup (wedge mounting, polar alignment) before dismissing.

## Offline operation

The kiosk works fully offline after initial setup. All assets are bundled locally:

| Asset | Size | Purpose |
|-------|------|---------|
| TensorFlow.js | 1.4MB | Neural network runtime |
| Tone.js | 343KB | Audio synthesis and scheduling |
| Magenta core + MusicRNN | 388KB | AI music generation library |
| MusicRNN model | 5.3MB | Trained improvisation model |
| Salamander piano | 1.2MB | 30 Yamaha C5 grand piano samples |
| **Total** | **~8.7MB** | |

The kiosk HTML is served via a local Python HTTP server (port 8888) to enable `fetch()` for model loading — no internet traffic.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Discovery fails | Set `SEESTAR_IP` manually in `config.sh` |
| Alpaca not responding | Check `logs/seestar_alp.log`, verify port 5555 is free |
| Wide PiP black | Enable Wide Cam in the Seestar SSC mobile app first |
| Wide PiP shows OFFLINE | Restart wide proxy: `pkill -f wide_proxy.py` and relaunch |
| Jazz no sound | Click anywhere first (Chrome autoplay policy), then press `J` |
| MIDI not detected | Use Chrome (not Safari), check USB cable, click "Refresh MIDI" |
| AI engine not loading | Check Chrome console for model load errors; verify `kiosk/lib/magenta-model/` exists |
| Chrome crashes | TensorFlow.js + model may use significant memory; close other Chrome tabs |
| Quit confirmation skipped | Ensure you didn't accidentally double-tap Q; first Q shows confirmation, second Q confirms |

## License

MIT

## Credits

- [seestar_alp](https://github.com/smart-underworld/seestar_alp) — Alpaca proxy for Seestar
- [Magenta](https://magenta.tensorflow.org/) — AI music generation (Google)
- [Tone.js](https://tonejs.github.io/) — Web Audio framework
- [Salamander Grand Piano](https://sfzinstruments.github.io/pianos/salamander/) — Piano samples (CC BY 3.0)
- [TensorFlow.js](https://www.tensorflow.org/js) — ML runtime for the browser
