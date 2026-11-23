#!/usr/bin/env python3
"""Render the site's Open Graph cards.

The design lives in `card.html`, with three placeholders: eyebrow, headline and
body. Each card here is a variant of it, rendered in headless Chromium at 2x,
downsampled to 1200x630 and flattened to RGB (an alpha channel is rejected by
some social platforms).

    python3 og/render.py            # write every card
    python3 og/render.py --check    # fail if a committed image is stale

Chromium must be on PATH, or pass --browser. Pillow is needed for the resize.
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
WIDTH, HEIGHT = 1200, 630
SCALE = 2

CARDS = [
    {
        "out": "og-image.png",
        "eyebrow": "FREE &middot; OPEN SOURCE",
        "headline": "Python REPL and<br>turtle editor",
        "size": 45,
        "body": "Real CPython in WebAssembly. Save in the browser, download a .py, or "
                "commit to GitHub.",
    },
    {
        "out": "og-teachers.png",
        "eyebrow": "FOR TEACHERS &middot; NO STUDENT ACCOUNTS",
        "headline": "Python in class,<br>nothing to install",
        "size": 42,
        "body": "Students write Python and commit to a repository they own, so git "
                "comes with the lesson.",
    },
    {
        "out": "og-turtle.png",
        "eyebrow": "PYTHON TURTLE &middot; BROWSER",
        "headline": "Python turtle,<br>drawn in the browser",
        "size": 36,
        "body": "Real CPython in WebAssembly. Loops, colours and fills, with no "
                "install and no Tkinter.",
    },
    {
        "out": "og-trinket.png",
        "eyebrow": "TRINKET CLOSED &middot; 31 AUGUST 2026",
        "headline": "A Trinket<br>alternative",
        "size": 45,
        "body": "Python and turtle with no account and no server. MIT licensed, so "
                "a school can host its own copy.",
    },
]


def find_browser(explicit: str | None) -> str:
    if explicit:
        return explicit
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        path = shutil.which(name)
        if path:
            return path
    raise SystemExit("No Chromium found. Pass --browser /path/to/chrome.")


def render(card: dict, browser: str, out: Path) -> None:
    html = (HERE / "card.html").read_text()
    html = (html
            .replace("{{EYEBROW}}", card["eyebrow"])
            .replace("{{HEADLINE}}", card["headline"])
            .replace("{{HEADLINE_SIZE}}", str(card["size"]))
            .replace("{{BODY}}", card["body"]))

    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "card.html"
        page.write_text(html)
        (Path(tmp) / "assets").symlink_to(HERE / "assets")
        shot = Path(tmp) / "shot.png"
        subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--hide-scrollbars", f"--force-device-scale-factor={SCALE}",
             f"--window-size={WIDTH},{HEIGHT}", "--virtual-time-budget=2000",
             f"--screenshot={shot}", page.as_uri()],
            check=True, capture_output=True,
        )
        image = Image.open(shot).convert("RGB")
        image = image.resize((WIDTH, HEIGHT), Image.LANCZOS)
        image.save(out, "PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="render and compare with the committed files")
    parser.add_argument("--out", help="write only the first card here")
    parser.add_argument("--browser", help="Chromium binary to use")
    args = parser.parse_args()

    browser = find_browser(args.browser)
    cards = CARDS[:1] if args.out else CARDS
    stale = []

    with tempfile.TemporaryDirectory() as tmp:
        for card in cards:
            target = Path(args.out) if args.out else HERE.parent / card["out"]
            if args.check:
                fresh = Path(tmp) / card["out"]
                render(card, browser, fresh)
                if not target.exists() or fresh.read_bytes() != target.read_bytes():
                    stale.append(card["out"])
            else:
                render(card, browser, target)
                print(f"wrote {target}")

    if args.check and stale:
        print("stale: " + ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
