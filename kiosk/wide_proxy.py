#!/usr/bin/env python3
"""Tiny MJPEG proxy for Seestar wide-angle (finder) camera.

Reads RTSP from telescope:4555/stream via OpenCV, serves MJPEG on local port.
"""
from __future__ import annotations

import json
import sys
import threading
import time

import cv2
from flask import Flask, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Shared state
_lock = threading.Lock()
_frame: bytes | None = None
_frame_ts: float = 0  # timestamp of last captured frame
_running = True

# Output width (height scales proportionally)
OUTPUT_WIDTH = 640


def rtsp_reader(uri: str):
    """Background thread: read RTSP frames into shared buffer."""
    global _frame, _frame_ts, _running
    while _running:
        try:
            # Force TCP transport for reliability
            cap = cv2.VideoCapture(uri, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                print(f"[wide] Cannot open {uri}, retrying in 3s...", file=sys.stderr)
                time.sleep(3)
                continue
            print(f"[wide] Connected to {uri}", file=sys.stderr)
            while _running:
                ret, img = cap.read()
                if not ret:
                    break
                # Resize to OUTPUT_WIDTH for bandwidth savings
                h, w = img.shape[:2]
                if w > OUTPUT_WIDTH:
                    scale = OUTPUT_WIDTH / w
                    img = cv2.resize(img, (OUTPUT_WIDTH, int(h * scale)),
                                     interpolation=cv2.INTER_AREA)
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                if ok:
                    with _lock:
                        _frame = buf.tobytes()
                        _frame_ts = time.time()
                time.sleep(0.05)  # ~20 fps cap
            cap.release()
            print("[wide] RTSP disconnected, reconnecting...", file=sys.stderr)
        except Exception as e:
            print(f"[wide] Error: {e}", file=sys.stderr)
            time.sleep(3)


def gen_mjpeg():
    """MJPEG generator for Flask response."""
    while True:
        with _lock:
            f = _frame
        if f:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + f + b"\r\n"
            )
        time.sleep(0.1)  # ~10 fps output


@app.route("/vid")
def vid():
    return Response(gen_mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/health")
def health():
    with _lock:
        ts = _frame_ts
    age = time.time() - ts if ts > 0 else -1
    return Response(
        json.dumps({"ok": age < 5 and age >= 0, "frame_age": round(age, 1), "ts": ts}),
        mimetype="application/json",
    )


def main():
    if len(sys.argv) < 2:
        print("Usage: wide_proxy.py <seestar_ip> [port]", file=sys.stderr)
        sys.exit(1)

    seestar_ip = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 7557

    rtsp_uri = f"rtsp://{seestar_ip}:4555/stream"
    print(f"[wide] RTSP: {rtsp_uri} → MJPEG on :{port}/vid", file=sys.stderr)

    t = threading.Thread(target=rtsp_reader, args=(rtsp_uri,), daemon=True)
    t.start()

    import waitress
    waitress.serve(app, host="127.0.0.1", port=port, threads=4, channel_timeout=30)


if __name__ == "__main__":
    main()
