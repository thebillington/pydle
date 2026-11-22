# Vendored CodeMirror

| File | Version |
|---|---|
| `codemirror.min.js`, `codemirror.min.css` | 5.65.16 |
| `python.min.js`, `comment.min.js`, `dracula.min.css` | 5.65.16 |
| `addon/**` | 5.65.16 |

The site is loaded with plain `<script>` tags and no build step, so everything is
committed rather than fetched from a CDN: pydle has to work offline and must not
depend on a third party at runtime.

The addons were taken from `unpkg.com/codemirror@5.65.16/` and are unmodified. Keep
the version in step with `codemirror.min.js` — CodeMirror 5 addons are not
guaranteed to work across minor versions.

MIT licensed, copyright Marijn Haverbeke and others. See the repository LICENSE.
