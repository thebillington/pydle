# pydle

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/thebillington)

pydle is a free browser-based Python playground built with Pyodide and deployed
on GitHub Pages.

- Live site: [https://pydle.uk](https://pydle.uk)
- Turtle guide: [https://pydle.uk/python-turtle-online/](https://pydle.uk/python-turtle-online/)
- Trinket alternative: [https://pydle.uk/trinket-alternative/](https://pydle.uk/trinket-alternative/)

It has two main entry points:

- `/` - a general-purpose Python REPL with an editor, console, save/load, and download-to-file support
- `/turtle/` - a Python turtle graphics environment backed by a custom in-browser turtle implementation

The site is published at the custom domain `https://pydle.uk`.

## What It Runs

pydle is entirely static on the frontend:

- the editor is CodeMirror
- Python runs inside a Web Worker via Pyodide
- stdout is streamed back to the page
- saved scripts live in browser local storage
- the turtle page draws into an `OffscreenCanvas` and sends rendered frames back to the UI

There is no backend service. Everything runs in the browser.

## Python Implementation

The interesting part of this repo is the Python layer that is embedded into the browser runtime.

### REPL

The main REPL at `/` loads `worker.js`, which:

- boots Pyodide in a worker
- loads any local Python modules into Pyodide's virtual filesystem
- redirects Python stdout into the page console
- executes user code asynchronously so the UI stays responsive

### Turtle

The turtle app under `/turtle/` uses a custom `modules/turtle.py` rather than CPython's desktop turtle module.

That module:

- creates an `OffscreenCanvas`
- implements the drawing primitives needed by turtle programs
- keeps track of turtle state in Python
- flushes frames back to the page for display

The turtle worker is intentionally lightweight:

- it loads Pyodide
- injects `modules/turtle.py`
- calls into the Python turtle shim
- forwards frames and status messages to the main thread

This approach keeps the app portable and lets normal turtle programs run in the browser with only a small amount of adaptation.

## GitHub Pages Setup

This repo is designed to be deployed as a static GitHub Pages site.

- `main` contains the source
- `gh-pages` contains the published site
- `CNAME` points the site at `pydle.uk`

The published site is just static HTML, CSS, JavaScript, and vendored runtime assets. No build step is required.

## Local Development

Serve the repository root and open it in a browser:

```bash
python3 -m http.server 8080
```

Then visit:

- `http://localhost:8080/` for the REPL
- `http://localhost:8080/turtle/` for the turtle app

## Repository Layout

- `index.html` - main REPL entry point
- `worker.js` - main Python worker
- `modules/` - Python modules loaded into Pyodide
- `style.css` - shared UI styling
- `turtle/` - turtle-specific app, worker, and styles
- `vendor/` - vendored CodeMirror, Pyodide, and other static dependencies
- `CNAME` - custom domain for GitHub Pages

## Support

This project is free and open source. If it saves you time, you can support
ongoing maintenance through [GitHub Sponsors](https://github.com/sponsors/thebillington).

## Notes

- Saved files are browser-local only unless you download them
- The browser worker model keeps execution responsive, but Python code still runs in a single worker thread
- The turtle environment is a compatibility layer, not a full desktop turtle clone

