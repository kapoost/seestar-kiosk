#!/usr/bin/env python3
"""Discover Seestar telescope on the local network.

Strategy (in order):
1. mDNS — resolve seestar.local via socket.getaddrinfo (macOS Bonjour)
2. Alpaca Discovery — UDP broadcast 'alpacadiscovery1' on port 32227
3. ARP scan — parse 'arp -a', try GET /api/v1/telescope/0/name on each candidate

Prints the discovered IP to stdout. Exit code != 0 if nothing found.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import re
import urllib.request
import urllib.error


def discover_mdns(hostname: str = "seestar.local", port: int = 4700) -> str | None:
    """Try resolving seestar.local via Bonjour/mDNS."""
    try:
        results = socket.getaddrinfo(hostname, port, socket.AF_INET)
        if results:
            ip = results[0][4][0]
            # Verify it's not just a DNS lookup returning something weird
            if ip and not ip.startswith("127."):
                return ip
    except socket.gaierror:
        pass
    return None


def discover_alpaca(timeout: float = 3.0) -> str | None:
    """Alpaca Discovery Protocol — UDP broadcast on port 32227.

    Reference: device/discovery.py:113 in seestar_alp — responder expects
    'alpacadiscovery1' and replies with JSON containing AlpacaPort.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(timeout)
    try:
        sock.sendto(b"alpacadiscovery1", ("255.255.255.255", 32227))
        while True:
            try:
                data, addr = sock.recvfrom(1024)
                # Response is JSON like {"AlpacaPort": 5555}
                response = json.loads(data.decode("ascii", errors="ignore"))
                if "AlpacaPort" in response:
                    return addr[0]
            except socket.timeout:
                break
    except OSError:
        pass
    finally:
        sock.close()
    return None


def discover_arp_scan(alpaca_port: int = 5555, timeout: float = 2.0) -> str | None:
    """Parse ARP table and probe each candidate for Alpaca telescope API.

    Checks GET /api/v1/telescope/0/name — if response contains 'Seestar',
    we found it.
    """
    try:
        result = subprocess.run(
            ["arp", "-a"], capture_output=True, text=True, timeout=5
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None

    # Parse IPs from arp output: lines like "? (192.168.1.42) at aa:bb:cc..."
    ip_pattern = re.compile(r"\((\d+\.\d+\.\d+\.\d+)\)")
    candidates = ip_pattern.findall(result.stdout)

    for ip in candidates:
        try:
            url = f"http://{ip}:{alpaca_port}/api/v1/telescope/0/name?ClientID=1&ClientTransactionID=1"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode())
                value = body.get("Value", "")
                if "seestar" in value.lower():
                    return ip
        except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError):
            continue
    return None


def main() -> int:
    print("Szukam teleskopu Seestar w sieci...", file=sys.stderr)

    # 1. mDNS
    print("  [1/3] mDNS (seestar.local)...", file=sys.stderr)
    ip = discover_mdns()
    if ip:
        print(f"  → Znaleziono przez mDNS: {ip}", file=sys.stderr)
        print(ip)
        return 0

    # 2. Alpaca Discovery
    print("  [2/3] Alpaca Discovery (UDP broadcast)...", file=sys.stderr)
    ip = discover_alpaca()
    if ip:
        print(f"  → Znaleziono przez Alpaca Discovery: {ip}", file=sys.stderr)
        print(ip)
        return 0

    # 3. ARP scan
    print("  [3/3] Skan ARP + probe Alpaca API...", file=sys.stderr)
    ip = discover_arp_scan()
    if ip:
        print(f"  → Znaleziono przez skan ARP: {ip}", file=sys.stderr)
        print(ip)
        return 0

    print(
        "\n✗ Nie znaleziono teleskopu Seestar w sieci.\n"
        "  Sprawdź czy:\n"
        "  - Seestar jest włączony i podłączony do Wi-Fi (tryb Station)\n"
        "  - MacBook jest w tej samej sieci\n"
        "  - Lub ustaw SEESTAR_IP ręcznie w config.sh\n",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
