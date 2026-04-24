#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  Seestar Kiosk — Field Launcher (direct telescope WiFi)
#
#  Use this when connecting directly to the telescope's hotspot
#  (no home router). Handles WiFi switching, AP-mode IP, and
#  verifies connectivity before launching the main kiosk.
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Defaults for AP mode ──────────────────────────────────────
SEESTAR_AP_IP="${SEESTAR_AP_IP:-192.168.100.1}"
SEESTAR_SSID="${SEESTAR_SSID:-}"

# ─── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
RST='\033[0m'

info()  { echo -e "${GRN}✓${RST} $*"; }
warn()  { echo -e "${YEL}!${RST} $*"; }
fail()  { echo -e "${RED}✗${RST} $*"; exit 1; }

# ─── Help ──────────────────────────────────────────────────────
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    cat <<HELP
Seestar Kiosk — Field Launcher

Usage: ./kiosk/launcher-field.sh [OPTIONS]

Connects directly to the telescope's WiFi hotspot and launches the kiosk.

Options:
  --ssid NAME       Telescope WiFi SSID (default: auto-detect "SEESTAR*")
  --ip ADDRESS      Telescope AP-mode IP (default: 192.168.100.1)
  --skip-wifi       Skip WiFi switching (already connected manually)
  -h, --help        Show this help

Environment:
  SEESTAR_AP_IP     Same as --ip
  SEESTAR_SSID      Same as --ssid

Examples:
  ./kiosk/launcher-field.sh                          # auto-detect SSID
  ./kiosk/launcher-field.sh --ssid "SEESTAR_S30_AB"  # specific telescope
  ./kiosk/launcher-field.sh --skip-wifi --ip 10.0.0.1
HELP
    exit 0
fi

# ─── Parse args ────────────────────────────────────────────────
SKIP_WIFI=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ssid)     SEESTAR_SSID="$2"; shift 2 ;;
        --ip)       SEESTAR_AP_IP="$2"; shift 2 ;;
        --skip-wifi) SKIP_WIFI=1; shift ;;
        *) fail "Unknown option: $1. Use --help." ;;
    esac
done

echo ""
echo "════════════════════════════════════════════"
echo "  SEESTAR KIOSK — FIELD MODE"
echo "  Direct telescope WiFi connection"
echo "════════════════════════════════════════════"
echo ""

# ─── 1. Save current WiFi network ─────────────────────────────
ORIGINAL_SSID=""
if [[ "$SKIP_WIFI" -eq 0 ]]; then
    WIFI_IF=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
    if [[ -z "$WIFI_IF" ]]; then
        fail "Nie znaleziono interfejsu Wi-Fi."
    fi

    ORIGINAL_SSID=$(networksetup -getairportnetwork "$WIFI_IF" 2>/dev/null | sed 's/Current Wi-Fi Network: //' || echo "")
    if [[ -n "$ORIGINAL_SSID" ]]; then
        info "Aktualna sieć: $ORIGINAL_SSID (przywrócę po zamknięciu)"
    fi
fi

# ─── Restore WiFi on exit ─────────────────────────────────────
restore_wifi() {
    if [[ -n "$ORIGINAL_SSID" && "$SKIP_WIFI" -eq 0 ]]; then
        echo ""
        warn "Przywracam WiFi: $ORIGINAL_SSID..."
        networksetup -setairportnetwork "$WIFI_IF" "$ORIGINAL_SSID" 2>/dev/null || true
        # Wait for reconnection
        for i in $(seq 1 10); do
            CURRENT=$(networksetup -getairportnetwork "$WIFI_IF" 2>/dev/null | sed 's/Current Wi-Fi Network: //' || echo "")
            if [[ "$CURRENT" == "$ORIGINAL_SSID" ]]; then
                info "Przywrócono sieć: $ORIGINAL_SSID"
                return
            fi
            sleep 1
        done
        warn "Nie udało się przywrócić sieci automatycznie. Połącz się ręcznie z: $ORIGINAL_SSID"
    fi
}
trap restore_wifi EXIT

# ─── 2. Find and connect to Seestar WiFi ──────────────────────
if [[ "$SKIP_WIFI" -eq 0 ]]; then
    if [[ -z "$SEESTAR_SSID" ]]; then
        echo "Szukam sieci Seestar..."
        # Scan for SEESTAR* SSIDs
        SCAN=$("$SCRIPT_DIR/../.venv/bin/python" -c "
import subprocess, re
out = subprocess.check_output(
    ['/System/Library/PrivateFrameworks/Apple80211.framework/Resources/airport', '-s'],
    text=True
)
for line in out.strip().split('\n')[1:]:
    ssid = line[:33].strip()
    if ssid.upper().startswith('SEESTAR'):
        print(ssid)
        break
" 2>/dev/null || echo "")

        if [[ -z "$SCAN" ]]; then
            # Fallback: try airport directly
            SCAN=$(
                /System/Library/PrivateFrameworks/Apple80211.framework/Resources/airport -s 2>/dev/null \
                | awk 'NR>1 {name=substr($0,1,33); gsub(/^ +| +$/,"",name); if (toupper(name) ~ /^SEESTAR/) {print name; exit}}'
            ) || true
        fi

        if [[ -z "$SCAN" ]]; then
            fail "Nie znaleziono sieci SEESTAR*. Włącz teleskop i spróbuj ponownie, lub użyj --ssid."
        fi
        SEESTAR_SSID="$SCAN"
    fi

    # Check if already connected
    CURRENT_SSID=$(networksetup -getairportnetwork "$WIFI_IF" 2>/dev/null | sed 's/Current Wi-Fi Network: //' || echo "")
    if [[ "$CURRENT_SSID" == "$SEESTAR_SSID" ]]; then
        info "Już połączono z: $SEESTAR_SSID"
    else
        echo "Łączę z: $SEESTAR_SSID..."
        networksetup -setairportnetwork "$WIFI_IF" "$SEESTAR_SSID" 2>/dev/null || fail "Nie udało się połączyć z $SEESTAR_SSID"

        # Wait for connection
        for i in $(seq 1 15); do
            CURRENT=$(networksetup -getairportnetwork "$WIFI_IF" 2>/dev/null | sed 's/Current Wi-Fi Network: //' || echo "")
            if [[ "$CURRENT" == "$SEESTAR_SSID" ]]; then
                info "Połączono z: $SEESTAR_SSID"
                break
            fi
            if [[ "$i" -eq 15 ]]; then
                fail "Timeout łączenia z $SEESTAR_SSID"
            fi
            sleep 1
        done
        # Let DHCP settle
        sleep 2
    fi
fi

# ─── 3. Detect telescope IP ───────────────────────────────────
echo "Sprawdzam IP teleskopu: $SEESTAR_AP_IP..."

if ! ping -c 1 -W 3 "$SEESTAR_AP_IP" >/dev/null 2>&1; then
    # Try common AP-mode addresses
    warn "$SEESTAR_AP_IP nie odpowiada. Sprawdzam alternatywne adresy..."
    for ALT_IP in "192.168.100.1" "192.168.0.1" "10.0.0.1" "192.168.1.1"; do
        if [[ "$ALT_IP" != "$SEESTAR_AP_IP" ]]; then
            if ping -c 1 -W 2 "$ALT_IP" >/dev/null 2>&1; then
                SEESTAR_AP_IP="$ALT_IP"
                info "Znaleziono teleskop pod: $ALT_IP"
                break
            fi
        fi
    done

    # Last resort: check gateway
    if ! ping -c 1 -W 2 "$SEESTAR_AP_IP" >/dev/null 2>&1; then
        GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}' || echo "")
        if [[ -n "$GW" ]] && ping -c 1 -W 2 "$GW" >/dev/null 2>&1; then
            SEESTAR_AP_IP="$GW"
            info "Używam gateway jako IP teleskopu: $GW"
        else
            fail "Nie mogę znaleźć teleskopu. Użyj --ip ADDRESS."
        fi
    fi
fi

info "Teleskop osiągalny: $SEESTAR_AP_IP"

# ─── 4. Write field config and launch ─────────────────────────
FIELD_CONFIG="$PROJECT_DIR/config-field.sh"

# Preserve existing config values, override IP
if [[ -f "$PROJECT_DIR/config.sh" ]]; then
    cp "$PROJECT_DIR/config.sh" "$FIELD_CONFIG"
else
    cp "$PROJECT_DIR/config.sh.example" "$FIELD_CONFIG"
fi

# Override SEESTAR_IP in field config
if grep -q '^SEESTAR_IP=' "$FIELD_CONFIG"; then
    sed -i '' "s|^SEESTAR_IP=.*|SEESTAR_IP=\"$SEESTAR_AP_IP\"|" "$FIELD_CONFIG"
else
    echo "SEESTAR_IP=\"$SEESTAR_AP_IP\"" >> "$FIELD_CONFIG"
fi

echo ""
info "Field config zapisany: $FIELD_CONFIG"
info "Telescope IP: $SEESTAR_AP_IP"
echo ""

# ─── 5. Launch main kiosk with field config ───────────────────
echo "Uruchamiam kiosk..."
echo ""

# Temporarily swap config
ORIG_CONFIG="$PROJECT_DIR/config.sh"
BACKUP_CONFIG="$PROJECT_DIR/config.sh.home-backup"

if [[ -f "$ORIG_CONFIG" ]]; then
    cp "$ORIG_CONFIG" "$BACKUP_CONFIG"
fi
cp "$FIELD_CONFIG" "$ORIG_CONFIG"

# Restore home config on exit (before WiFi restore)
restore_config() {
    if [[ -f "$BACKUP_CONFIG" ]]; then
        cp "$BACKUP_CONFIG" "$ORIG_CONFIG"
        rm -f "$BACKUP_CONFIG"
    fi
    rm -f "$FIELD_CONFIG"
    restore_wifi
}
trap restore_config EXIT

# Run the main launcher
exec "$SCRIPT_DIR/launcher.sh"
