# Seestar Kiosk

Live-stacked view from ZWO Seestar S30 Pro on a projector. Full-screen, dark-adapted, one-script launch.

Includes a procedural jazz engine that turns telescope data into music in real time.

## Features

- **Live view** — MJPEG stream with auto-reconnect, crop/contain toggle
- **Control panel** — Messier/NGC catalog, GoTo, stacking, scenery (photo), video recording
- **Pilot** — D-pad manual movement, zoom, tracking, plate solve, focus
- **Wide-angle PiP** — finder camera via RTSP→MJPEG proxy, crosshair overlay
- **Jazz engine** — procedural music driven by stacking telemetry:
  - New stack → melody note (pitch from RA, octave from Dec, velocity from SNR)
  - Star density in image → ghost note frequency
  - Image colors → auto key/scale changes (hue→circle of fifths, diversity→scale complexity)
  - Rhodes-like synth with reverb, chorus, ADSR, stereo panning
  - MIDI output to USB piano (Web MIDI API)
- **Day / Night mode** — red-on-black (night) or blue-on-white (day)

## Requirements

- macOS with Bonjour
- Python 3.11+ (`brew install python@3.11`)
- Google Chrome
- ZWO Seestar S30 Pro in Station mode (same Wi-Fi as MacBook)
- HDMI projector (optional — works on single screen too)
- USB piano for MIDI output (optional — built-in synth works standalone)

## Quick start

```bash
# First time — clone dependency & setup venv:
git clone https://github.com/smart-underworld/seestar_alp.git vendor/seestar_alp
python3.11 -m venv .venv
.venv/bin/pip install -r vendor/seestar_alp/requirements.txt
.venv/bin/pip install flask flask-cors opencv-python-headless waitress

# Copy and edit config:
cp config.sh.example config.sh
# Edit SEESTAR_IP, paths, ports as needed

# Launch:
./kiosk/launcher.sh
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Q` / `Esc` | Close kiosk (or panel) |
| `F` | Toggle status overlay |
| `C` | Crop / contain image |
| `W` | Wide-angle PiP |
| `P` | Control + Jazz panels |
| `D` | Day / Night mode |
| `J` | Jazz on / off |
| `H` | Help (4s) |

## Jazz engine

The jazz engine maps telescope telemetry to music parameters:

```
stacked_frame +1  → melody note
SNR               → velocity
RA (0–24h)        → pitch (scale degree)
Dec (-90°–+90°)   → octave
dropped_frame     → dissonant grace note
star density      → ghost note rate
dominant hue      → key (color wheel → circle of fifths)
color diversity   → scale complexity (pentatonic → diminished)
state: working    → full ensemble
state: slewing    → fast bass (tension)
state: idle       → ambient pad only
integration time  → note duration (longer over time)
```

### Synth quality (when MIDI unavailable)

Built-in Web Audio synth with:
- Custom `PeriodicWave` modeling Fender Rhodes harmonics
- Dual detuned oscillators (chorus effect)
- LFO vibrato (4.5–6 Hz)
- Velocity-sensitive lowpass filter with envelope
- Exponential ADSR (piano-like decay)
- Algorithmic convolution reverb (2.5s IR with early reflections)
- Stereo panning per voice
- Sub-sine bass layer

### MIDI output

Connects to USB instruments via Web MIDI API. Auto-detects Roland/Casio digital pianos. Dual output: synth + MIDI can run simultaneously.

## Architecture

```
kiosk/launcher.sh    → orchestrator (discovery → ALP → proxy → Chrome)
kiosk/kiosk.html     → fullscreen kiosk (stream + controls + jazz)
kiosk/kiosk.css      → dark-adapted styling (night/day modes)
kiosk/jazz.js        → procedural jazz engine (Web Audio + Web MIDI)
kiosk/catalog.js     → Messier + NGC/IC object catalog
kiosk/wide_proxy.py  → RTSP→MJPEG proxy for wide-angle camera
kiosk/discover.py    → Seestar IP discovery (mDNS/UDP/ARP)
config.sh            → user configuration (gitignored)
vendor/seestar_alp/  → Alpaca proxy (cloned dependency)
```

## Troubleshooting

- **Discovery fails** — set `SEESTAR_IP` manually in `config.sh`
- **Alpaca not responding** — check `logs/seestar_alp.log`, verify port 5555 free
- **Wide PiP black** — enable Wide Cam in Seestar SSC mobile app first
- **Jazz no sound** — click anywhere first (Chrome autoplay policy), then press J
- **MIDI not detected** — use Chrome (not Safari), check USB connection, click "Odśwież MIDI"
