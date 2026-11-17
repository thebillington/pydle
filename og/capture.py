#!/usr/bin/env python3
"""Capture the turtle drawing that og/card.html shows.

Runs the turtle editor from this repository in a headless browser, executes
`spiral.py` in it and screenshots the canvas. The image on the card is therefore
the app's own output, not a drawing.

    python3 og/capture.py

Requires Playwright with a Chromium (`playwright install chromium`), or pass
`--browser /path/to/chrome`.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socket
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "og" / "assets"
PROGRAM = REPO / "og" / "spiral.py"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def serve() -> tuple[socketserver.TCPServer, int]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(REPO))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", help="path to a Chrome or Chromium binary")
    args = ap.parse_args()

    httpd, port = serve()
    try:
        with sync_playwright() as p:
            launch = {"args": ["--no-sandbox"]}
            if args.browser:
                launch["executable_path"] = args.browser
            browser = p.chromium.launch(**launch)
            page = browser.new_page(viewport={"width": 1440, "height": 900},
                                    device_scale_factor=2)
            page.goto(f"http://127.0.0.1:{port}/turtle/", wait_until="domcontentloaded")
            # Pyodide has to finish loading before the Run button unlocks
            page.wait_for_function("!document.querySelector('#run-btn').disabled",
                                   timeout=180_000)
            page.evaluate("(code) => editor.setValue(code)", PROGRAM.read_text())
            page.click("#run-btn")
            page.wait_for_function(
                "document.querySelector('#status').textContent.includes('Finished')",
                timeout=180_000)
            ASSETS.mkdir(parents=True, exist_ok=True)
            page.locator("#canvas").screenshot(path=str(ASSETS / "drawing.png"))
            browser.close()
    finally:
        httpd.shutdown()
    print(f"og: captured {ASSETS / 'drawing.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
