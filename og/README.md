# og/

The Open Graph cards for pydle.uk. One design, one card per page.

- `card.html` — the design. Ordinary HTML and CSS, no image generation. Three
  placeholders (`{{EYEBROW}}`, `{{HEADLINE}}`, `{{HEADLINE_SIZE}}`, `{{BODY}}`)
  are filled per card.
- `assets/` — what the card draws: the turtle drawing and the two fonts.
- `capture.py` — runs the turtle editor in this repository and screenshots the
  canvas, so `assets/drawing.png` is the app's own output.
- `spiral.py` — the program that drew it.
- `render.py` — renders every card at 1200x630 and writes them to the repository
  root, where the pages expect them.

| Card | Used by |
|---|---|
| `og-image.png` | `/`, `/turtle/` |
| `og-teachers.png` | `/teachers/`, `/teachers/setup-sheet/` |
| `og-turtle.png` | `/python-turtle-online/` |
| `og-trinket.png` | `/trinket-alternative/` |

## Rebuilding

Chromium must be on `PATH`, and Pillow is needed for the resize:

```bash
pip install pillow

python3 og/render.py                       # write every card
python3 og/render.py --check               # fail if a committed card is stale
python3 og/render.py --browser /usr/bin/chromium
```

`--check` renders each card again and compares it with the committed PNG, so a
change to the copy that never made it into the image fails rather than ships.

## Notes

Each image is 1200x630 with no alpha channel. Text is kept short enough to wrap
inside the left column; a headline that reaches the code window means the size
in `render.py` is too large for its length.
