#!/usr/bin/env python3
"""Download Seestar APK from APKPure and extract PEM private key.

Same logic as seestar-tool/src/pem.rs — scans libopenssllib.so for PEM blocks.
"""
from __future__ import annotations

import io
import os
import re
import sys
import urllib.request
import zipfile
import json

APKPURE_API = "https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=com.zwo.seestar"

# Android device headers — ref: seestar-tool/src/apkpure.rs:333-369
HEADERS = {
    "User-Agent": "APKPure/3.17.25 (Linux; U; Android 10; Pixel 3 Build/QQ3A.200805.001)",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "x-cv": "3172501",
    "x-sv": "29",
    "x-abis": "arm64-v8a,armeabi-v7a,armeabi,x86,x86_64",
    "x-gp": "1",
}

SO_PATHS = [
    "lib/arm64-v8a/libopenssllib.so",
    "lib/armeabi-v7a/libopenssllib.so",
]

PEM_RE = re.compile(
    r"-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----"
)


def fetch_apk_url() -> tuple[str, str]:
    """Fetch latest version info from APKPure API.

    Response is protobuf — scan raw bytes for URLs and version strings.
    Ref: seestar-tool/src/apkpure.rs:270-327 — parse_protobuf_response
    """
    print("  Pobieram listę wersji z APKPure...", file=sys.stderr)
    req = urllib.request.Request(APKPURE_API, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = resp.read()

    # Scan raw binary for URLs (protobuf embeds them as length-prefixed strings)
    text = data.decode("latin-1")

    # URL pattern from seestar-tool tests: https://download.pureapk.com/b/XAPK/com.zwo.seestar_*.xapk
    url_re = re.compile(r'https?://[!-~]{10,300}\.(?:xapk|apk)')
    urls = url_re.findall(text)

    # Version strings (dotted triplet)
    ver_re = re.compile(r'(\d+\.\d+\.\d+)')
    versions = ver_re.findall(text)

    if urls:
        version = versions[0] if versions else "unknown"
        return urls[0], version

    # Fallback: construct known URL pattern
    # Ref: seestar-tool test constants — URL_2 = "https://download.pureapk.com/b/XAPK/com.zwo.seestar_3.1.2.xapk"
    if versions:
        ver = versions[0]
        fallback_url = f"https://download.pureapk.com/b/XAPK/com.zwo.seestar_{ver}.xapk"
        print(f"  API nie zwrócił URL — próbuję fallback: {fallback_url}", file=sys.stderr)
        return fallback_url, ver

    raise RuntimeError(
        f"Nie znaleziono URL do pobrania w odpowiedzi APKPure ({len(data)} bytes)"
    )


def download_apk(url: str, dest: str) -> None:
    """Download APK/XAPK file."""
    print(f"  Pobieram APK ({url[:80]}...)...", file=sys.stderr)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = downloaded * 100 // total
                    print(f"\r  {downloaded // (1024*1024)}MB / {total // (1024*1024)}MB ({pct}%)", end="", file=sys.stderr)
    print("", file=sys.stderr)


def extract_pem_from_zip(zip_path: str) -> list[str]:
    """Extract PEM keys from APK ZIP file — scans libopenssllib.so.

    Ref: seestar-tool/src/pem.rs:53 — extract_pem_from_apk
    """
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        # Might be XAPK (ZIP of ZIPs) — look for inner APK
        print("  XAPK format — szukam wewnętrznego APK...", file=sys.stderr)
        outer = zipfile.ZipFile(zip_path)
        for name in outer.namelist():
            if name.endswith(".apk"):
                print(f"  Rozpakowuję {name}...", file=sys.stderr)
                inner_data = outer.read(name)
                inner_path = zip_path + ".inner.apk"
                with open(inner_path, "wb") as f:
                    f.write(inner_data)
                result = extract_pem_from_zip(inner_path)
                os.unlink(inner_path)
                if result:
                    return result
        return []

    # Try XAPK structure (ZIP of APKs)
    apk_names = [n for n in zf.namelist() if n.endswith(".apk")]
    if apk_names and not any(n in zf.namelist() for n in SO_PATHS):
        print("  XAPK format — szukam wewnętrznego APK...", file=sys.stderr)
        for apk_name in apk_names:
            print(f"  Skanuję {apk_name}...", file=sys.stderr)
            inner_data = zf.read(apk_name)
            try:
                inner_zip = zipfile.ZipFile(io.BytesIO(inner_data))
                keys = _scan_zip_for_pem(inner_zip)
                if keys:
                    return keys
            except zipfile.BadZipFile:
                continue
        return []

    return _scan_zip_for_pem(zf)


def _scan_zip_for_pem(zf: zipfile.ZipFile) -> list[str]:
    """Scan ZIP for libopenssllib.so and extract PEM keys."""
    keys: set[str] = set()
    for so_path in SO_PATHS:
        if so_path in zf.namelist():
            print(f"  Skanuję {so_path}...", file=sys.stderr)
            data = zf.read(so_path)
            # Extract printable strings (like strings(1)) — ref: pem.rs:17
            text = _extract_strings(data)
            found = PEM_RE.findall(text)
            print(f"  Znaleziono {len(found)} klucz(e) w {so_path}", file=sys.stderr)
            keys.update(found)
    return sorted(keys)


def _extract_strings(data: bytes, min_len: int = 4) -> str:
    """Extract printable ASCII strings from binary data (like strings(1)).

    Ref: seestar-tool/src/pem.rs:17 — extract_strings
    """
    result = []
    current = []
    for b in data:
        if 32 <= b <= 126:  # printable ASCII
            current.append(chr(b))
        else:
            if len(current) >= min_len:
                result.append("".join(current))
            current = []
    if len(current) >= min_len:
        result.append("".join(current))
    return "\n".join(result)


def main() -> int:
    output_path = os.path.expanduser("~/.seestar/interop.pem")

    if os.path.exists(output_path):
        print(f"Klucz PEM już istnieje: {output_path}", file=sys.stderr)
        print(output_path)
        return 0

    print("Ekstrakcja klucza PEM z APK Seestar...", file=sys.stderr)

    # 1. Download APK
    cache_dir = os.path.expanduser("~/.seestar/cache")
    os.makedirs(cache_dir, exist_ok=True)

    # Check for cached APK
    cached = [f for f in os.listdir(cache_dir) if f.endswith((".apk", ".xapk"))]
    if cached:
        apk_path = os.path.join(cache_dir, cached[0])
        print(f"  Używam cached APK: {apk_path}", file=sys.stderr)
    else:
        try:
            url, version = fetch_apk_url()
            print(f"  Wersja: {version}", file=sys.stderr)
            ext = "xapk" if ".xapk" in url else "apk"
            apk_path = os.path.join(cache_dir, f"seestar_{version}.{ext}")
            download_apk(url, apk_path)
        except Exception as e:
            print(f"\n✗ Nie udało się pobrać APK: {e}", file=sys.stderr)
            print("  Pobierz APK ręcznie i podaj ścieżkę jako argument.", file=sys.stderr)
            return 1

    # 2. Extract PEM
    print("  Szukam klucza PEM w APK...", file=sys.stderr)
    keys = extract_pem_from_zip(apk_path)

    if not keys:
        print("✗ Nie znaleziono klucza PEM w APK.", file=sys.stderr)
        return 1

    # 3. Save
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        f.write(keys[0] + "\n")
    os.chmod(output_path, 0o600)

    print(f"\n✓ Klucz PEM zapisany: {output_path}", file=sys.stderr)
    print(output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
