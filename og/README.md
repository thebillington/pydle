# og/

The Open Graph card for pydle.uk.

- `card.html` — the design. Ordinary HTML and CSS, no image generation. Four
  placeholders (`{{EYEBROW}}`, `{{HEADLINE}}`, `{{HEADLINE_SIZE}}`, `{{BODY}}`)
  are filled by the renderer.
- `assets/` — what the card draws: the turtle drawing and the two fonts.
- `capture.py` — runs the turtle editor in this repository and screenshots the
  canvas, so `assets/drawing.png` is the app's own output.
- `spiral.py` — the program that drew it.
- `render.py` — renders the card at 1200x630 and writes `og-image.png` to the
  repository root, where every page expects it.

## Rebuilding

Chromium must be on `PATH`, and Pillow is needed for the resize:

```bash
pip install pillow

python3 og/render.py                       # write the image
python3 og/render.py --check               # fail if the committed image is stale
python3 og/render.py --browser /usr/bin/chromium
```

`--check` renders the card again and compares it with the committed PNG, so a
change to the copy that never made it into the image fails rather than ships.

## Notes

The image is 1200x630 with no alpha channel. Text has to wrap inside the left
column; a headline that reaches the code window means the size in `render.py`
is too large for its length.

Pages reference the image as `og-image.png?v=2`. The query is not decoration:
GitHub Pages serves PNGs with a four hour cache, so a re-rendered image under an
unchanged URL can be stale at the edge. Bump the number when the card changes.
