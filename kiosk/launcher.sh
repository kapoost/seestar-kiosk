#!/usr/bin/env bash
set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Load config ─────────────────────────────────────────────────
source "$PROJECT_DIR/config.sh"

LOGS_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOGS_DIR"

ALP_PID_FILE="$LOGS_DIR/seestar_alp.pid"
ALP_LOG_FILE="$LOGS_DIR/seestar_alp.log"
WIDE_PID_FILE="$LOGS_DIR/wide_proxy.pid"
WIDE_LOG_FILE="$LOGS_DIR/wide_proxy.log"

PYTHON="$VENV_PATH/bin/python"

# ─── Cleanup on exit ────────────────────────────────────────────
cleanup() {
    echo ""
    echo "Zamykam seestar_alp..."
    if [[ -f "$ALP_PID_FILE" ]]; then
        local pid
        pid=$(cat "$ALP_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            # Wait up to 5s for graceful shutdown
            for i in $(seq 1 10); do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.5
            done
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$ALP_PID_FILE"
    fi
    echo "Zamykam wide_proxy..."
    if [[ -f "$WIDE_PID_FILE" ]]; then
        local wpid
        wpid=$(cat "$WIDE_PID_FILE")
        kill "$wpid" 2>/dev/null || true
        rm -f "$WIDE_PID_FILE"
    fi
    pkill -f wide_proxy.py 2>/dev/null || true
    echo "Zamykam Chrome kiosk..."
    osascript -e 'tell application "Google Chrome" to close (every window whose name contains "Seestar Kiosk")' 2>/dev/null || true
    echo "Gotowe."
}
trap cleanup EXIT INT TERM

# ─── 1. Discover or use configured IP ───────────────────────────
if [[ -z "${SEESTAR_IP:-}" ]]; then
    echo "SEESTAR_IP nie ustawione — uruchamiam discovery..."
    SEESTAR_IP=$("$PYTHON" "$SCRIPT_DIR/discover.py") || {
        echo "Discovery nie powiodło się. Ustaw SEESTAR_IP w config.sh."
        exit 1
    }
    echo "Znaleziono Seestar: $SEESTAR_IP"
fi

# ─── 2. Ping telescope ──────────────────────────────────────────
echo "Sprawdzam połączenie z $SEESTAR_IP..."
if ! ping -c 1 -W 2 "$SEESTAR_IP" >/dev/null 2>&1; then
    echo "✗ Seestar ($SEESTAR_IP) nie odpowiada na ping."
    echo "  Sprawdź czy teleskop jest włączony i w tej samej sieci."
    exit 1
fi
echo "✓ Seestar osiągalny."

# ─── 3. Write seestar_alp config.toml with discovered IP ────────
ALP_CONFIG="$SEESTAR_ALP_PATH/device/config.toml"
if [[ -f "$ALP_CONFIG" ]]; then
    # Backup existing config
    cp "$ALP_CONFIG" "$ALP_CONFIG.bak"
fi
cp "$SEESTAR_ALP_PATH/device/config.toml.example" "$ALP_CONFIG"

# Update seestar IP in config.toml
# Replace the ip_address in [[seestars]] section
"$PYTHON" -c "
import tomlkit, sys
with open('$ALP_CONFIG') as f:
    cfg = tomlkit.loads(f.read())
cfg['seestars'][0]['ip_address'] = '$SEESTAR_IP'
cfg['network']['ip_address'] = '0.0.0.0'
cfg['webui_settings']['uiport'] = $UI_PORT
pem_path = '$INTEROP_PEM'
if pem_path:
    cfg['seestar_initialization']['interop_pem'] = pem_path
with open('$ALP_CONFIG', 'w') as f:
    f.write(tomlkit.dumps(cfg))
msg = 'Config updated: seestar IP = $SEESTAR_IP, UI port = $UI_PORT'
if pem_path:
    msg += f', PEM = {pem_path}'
print(msg)
"

# ─── 4. Kill stale seestar_alp if running ─────────────────────────
if pgrep -f root_app.py >/dev/null 2>&1; then
    echo "Zabijam stary proces seestar_alp..."
    pkill -f root_app.py 2>/dev/null || true
    sleep 1
    # Force kill if still alive
    pkill -9 -f root_app.py 2>/dev/null || true
    sleep 0.5
fi
# Also check if our ports are in use
for port in "$ALPACA_PORT" "$IMG_PORT" "$UI_PORT"; do
    if lsof -i ":${port}" -P -n 2>/dev/null | grep -q LISTEN; then
        PID_ON_PORT=$(lsof -t -i ":${port}" -s TCP:LISTEN 2>/dev/null | head -1)
        if [[ -n "$PID_ON_PORT" ]]; then
            echo "  Port $port zajęty przez PID $PID_ON_PORT — kończę proces."
            kill "$PID_ON_PORT" 2>/dev/null || true
            sleep 0.5
        fi
    fi
done

# ─── 5. Start seestar_alp in background ─────────────────────────
echo "Uruchamiam seestar_alp..."
cd "$SEESTAR_ALP_PATH"
nohup "$PYTHON" root_app.py > "$ALP_LOG_FILE" 2>&1 &
ALP_PID=$!
echo "$ALP_PID" > "$ALP_PID_FILE"
echo "seestar_alp PID: $ALP_PID (logi: $ALP_LOG_FILE)"

# ─── 6. Wait for Alpaca API to respond ──────────────────────────
# ALP needs ~15s to connect to telescope before binding port 5555.
# Use /management/apiversions as health check (doesn't require device_num).
# Ref: device/app.py:302 — management endpoint always works.
echo "Czekam na Alpaca API (max 60s — teleskop potrzebuje czasu)..."
HEALTH_URL="http://localhost:${ALPACA_PORT}/management/apiversions"
ALP_READY=0
for i in $(seq 1 60); do
    if curl -sf --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
        echo "✓ Alpaca API odpowiada po ${i}s."
        ALP_READY=1
        break
    fi
    if ! kill -0 "$ALP_PID" 2>/dev/null; then
        echo "✗ seestar_alp zakończył się nieoczekiwanie. Sprawdź logi:"
        echo "  tail -30 $SEESTAR_ALP_PATH/alpyca.log"
        exit 1
    fi
    # Show progress every 10s
    if (( i % 10 == 0 )); then
        echo "  ...${i}s, wciąż czekam (teleskop się łączy)"
    fi
    sleep 1
done

if [[ "$ALP_READY" -eq 0 ]]; then
    echo "✗ Alpaca API nie odpowiada po 60s. Sprawdź logi:"
    echo "  tail -50 $SEESTAR_ALP_PATH/alpyca.log"
    exit 1
fi

# Wait for imaging port (should already be up, but verify)
echo "Sprawdzam Imaging API (port $IMG_PORT)..."
for i in $(seq 1 10); do
    if lsof -i ":${IMG_PORT}" -P -n 2>/dev/null | grep -q LISTEN; then
        echo "✓ Imaging API gotowe."
        break
    fi
    sleep 1
done

# ─── Wide-angle camera proxy ─────────────────────────────────
echo "Uruchamiam wide-angle proxy (port $WIDE_PORT)..."
pkill -f wide_proxy.py 2>/dev/null || true
nohup "$PYTHON" "$SCRIPT_DIR/wide_proxy.py" "$SEESTAR_IP" "$WIDE_PORT" > "$WIDE_LOG_FILE" 2>&1 &
WIDE_PID=$!
echo "$WIDE_PID" > "$WIDE_PID_FILE"
echo "wide_proxy PID: $WIDE_PID"

# ─── 7. Open kiosk in Chrome ────────────────────────────────────
KIOSK_URL="file://$SCRIPT_DIR/kiosk.html?host=localhost&imgport=${IMG_PORT}&devnum=${DEVICE_NUM}&alpacaport=${ALPACA_PORT}&wideport=${WIDE_PORT}"

echo ""
echo "Otwieram kiosk w Chrome..."

# Try to detect secondary display (projector) position
PROJECTOR_X=""
DISPLAY_INFO=$(system_profiler SPDisplaysDataType 2>/dev/null || true)

# Count displays — look for Resolution lines
DISPLAY_COUNT=$(echo "$DISPLAY_INFO" | grep -c "Resolution:" || echo "0")

if [[ "$DISPLAY_COUNT" -gt 1 ]]; then
    # Try to get the origin of the second display via AppleScript
    PROJECTOR_X=$(osascript -e '
        tell application "System Events"
            set displayCount to count of desktops
            if displayCount > 1 then
                -- The second display typically starts at the main display width
                tell desktop 1
                    set mainBounds to {0, 0}
                end tell
                return "auto"
            end if
        end tell
        return ""
    ' 2>/dev/null || echo "")
fi

if [[ "$DISPLAY_COUNT" -gt 1 ]]; then
    echo "Wykryto $DISPLAY_COUNT wyświetlaczy — otwieram na drugim ekranie."
    echo "(Jeśli okno nie trafiło na projektor, przeciągnij je ręcznie i naciśnij F11)"

    # Open Chrome in kiosk mode
    open -na "Google Chrome" --args \
        --new-window \
        --kiosk \
        --app="$KIOSK_URL" \
        --disable-web-security \
        --test-type \
        --user-data-dir=/tmp/seestar-kiosk-chrome \
        --disable-session-crashed-bubble \
        --disable-infobars \
        --noerrdialogs

    # Give Chrome a moment to open, then try to move window to second display
    sleep 2
    osascript -e '
        tell application "Google Chrome"
            if (count of windows) > 0 then
                set targetWindow to window 1
                set bounds of targetWindow to {2000, 0, 3920, 1080}
            end if
        end tell
    ' 2>/dev/null || true
else
    echo "Wykryto 1 wyświetlacz."
    echo "Podłącz projektor HDMI i uruchom ponownie, lub:"
    echo "  1. Okno otworzy się na tym ekranie"
    echo "  2. Przeciągnij na projektor"
    echo "  3. Naciśnij F11 (fullscreen)"
    echo ""

    open -na "Google Chrome" --args \
        --new-window \
        --app="$KIOSK_URL" \
        --disable-web-security \
        --test-type \
        --user-data-dir=/tmp/seestar-kiosk-chrome \
        --disable-session-crashed-bubble \
        --disable-infobars \
        --noerrdialogs
fi

echo ""
echo "════════════════════════════════════════════"
echo "  Seestar Kiosk działa."
echo "  UI seestar_alp: http://localhost:${UI_PORT}"
echo "  Klawisze: Q/Esc=zamknij  F=overlay  H=help"
echo "  Ctrl+C tutaj zamknie wszystko."
echo "════════════════════════════════════════════"
echo ""

# ─── 8. Wait for Ctrl+C ─────────────────────────────────────────
wait "$ALP_PID" 2>/dev/null || true
