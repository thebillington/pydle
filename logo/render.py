#!/usr/bin/env python3
"""Generate the pydle app logo and the site favicon from one source.

The mark is the one pydle already uses as its favicon: a dracula-dark rounded
square containing a terminal prompt, a green chevron and a white underscore.

The favicon shipped as an inline data URI, drawn with `<text>` and
`font-family: monospace`, which means the two glyphs were whatever monospace font
the viewer happened to have and were never quite centred. Here they are paths, so
the mark is identical everywhere, scales cleanly, and can be rasterised for the
GitHub OAuth app without depending on a font being installed.

Writes:

    favicon.svg          the site favicon (also usable as the app logo source)
    logo/logo-1024.png   general use
    logo/logo-512.png
    logo/logo-200.png    what GitHub's OAuth app form asks for

    python3 logo/render.py
    python3 logo/render.py --browser /path/to/chrome

Requires Pillow and a Chromium. Playwright is not needed: the browser is driven
directly, so this works where the playwright Python package is not installed.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

# Dracula, matching style.css.
BACKGROUND = "#282a36"
BORDER = "#6272a4"
CHEVRON = "#50fa7b"
UNDERSCORE = "#f8f8f2"

SIZES = (1024, 512, 200)

# Geometry in a 100x100 viewBox. The square is inset by half the border width so
# the stroke is not clipped at the edges.
SQUARE_INSET = 3
SQUARE_RADIUS = 12
BORDER_WIDTH = 4

# Stroke is generous because this is read at 16-40 px far more often than large.
GLYPH_WIDTH = 10

# A terminal prompt: > then a baseline underscore.
CHEVRON_POINTS = [(31, 37), (47, 50), (31, 63)]
UNDERSCORE_LINE = [(54, 63), (74, 63)]


def svg(size: int | None = None) -> str:
    """The mark as SVG. `size` sets width/height; the viewBox is always 100."""
    inset = SQUARE_INSET
    side = 100 - inset * 2

    chevron = " ".join(
        ("M" if index == 0 else "L") + f"{x},{y}" for index, (x, y) in enumerate(CHEVRON_POINTS)
    )
    (x1, y1), (x2, y2) = UNDERSCORE_LINE

    attributes = f'width="{size}" height="{size}" ' if size else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" {attributes}viewBox="0 0 100 100" role="img" aria-label="pydle">
  <rect x="{inset}" y="{inset}" width="{side}" height="{side}" rx="{SQUARE_RADIUS}"
        fill="{BACKGROUND}" stroke="{BORDER}" stroke-width="{BORDER_WIDTH}"/>
  <path d="{chevron}" fill="none" stroke="{CHEVRON}" stroke-width="{GLYPH_WIDTH}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{UNDERSCORE}"
        stroke-width="{GLYPH_WIDTH}" stroke-linecap="round"/>
</svg>
"""


def find_browser(explicit: str | None) -> str:
    if explicit:
        return explicit
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    cache = Path.home() / ".cache" / "ms-playwright"
    candidates = sorted(cache.glob("chromium-*/chrome-linux*/chrome"), reverse=True)
    if candidates:
        return str(candidates[0])
    raise SystemExit("logo: no Chromium found; pass --browser /path/to/chrome")


def rasterise(browser: str, html: str, size: int, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "logo.html"
        page.write_text(html)
        subprocess.run(
            [
                browser,
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                f"--window-size={size},{size}",
                f"--screenshot={out}",
                page.as_uri(),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", help="path to a Chrome or Chromium binary")
    args = ap.parse_args()

    browser = find_browser(args.browser)

    icon = REPO / "favicon.svg"
    icon.write_text(svg())
    print(f"logo: wrote {icon}")

    for size in SIZES:
        html = (
            "<!doctype html><html><head><style>html,body{margin:0;padding:0}"
            "</style></head><body>"
            f"{svg(size)}"
            "</body></html>"
        )
        out = HERE / f"logo-{size}.png"
        rasterise(browser, html, size, out)

        # Chromium's screenshot is not guaranteed to be exactly the window size.
        image = Image.open(out).convert("RGB")
        if image.size != (size, size):
            image = image.resize((size, size), Image.LANCZOS)
            image.save(out, optimize=True)

        print(f"logo: wrote {out} ({size}x{size}, {out.stat().st_size // 1024} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
