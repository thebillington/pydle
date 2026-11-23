// src/utils.ts
var escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var tmpl = (s, vars, transforms) => (s || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
  if (!(k in vars)) return "";
  const v = String(vars[k]);
  return transforms?.[k] ? transforms[k](v) : v;
});
var safeRegexTest = (pattern, input) => {
  try {
    return new RegExp(pattern, "i").test(input || "");
  } catch {
    return false;
  }
};

// src/engine.ts
var state = { adapters: {} };
var loadCopydeck = (deck) => state.copy = deck;
var getUiString = (key, fallback) => {
  return state.copy?.ui?.[key] || fallback;
};
var uniqueId = () => `pfem-${Math.random().toString(36).slice(2, 8)}`;
var registerAdapter = (name, fn) => state.adapters[name] = fn;
var coerceTrace = (input, code, runtime) => {
  if (input.raw !== void 0) return input;
  if (!runtime) {
    throw new Error("Runtime is required when error is a string or Error. Pass opts.runtime or parse with an adapter first.");
  }
  const adapter = state.adapters[runtime];
  if (!adapter) {
    throw new Error(`No adapter registered for runtime "${runtime}".`);
  }
  const raw = typeof input === "string" ? input : String(input.stack || input.message || input);
  const parsed = adapter(raw, code);
  if (!parsed) return null;
  parsed.runtime = runtime;
  return parsed;
};
var pickVariant = (trace, code, sections) => {
  const deck = state.copy;
  const kind = trace.type;
  const entry = kind ? deck?.errors[kind] : void 0;
  if (!entry) return null;
  const codeLine = trace.codeLine || "";
  const msg = trace.message || "";
  const matches = (v) => {
    const cond = v.if;
    if (!cond) return true;
    if (cond.match_message?.some((p) => safeRegexTest(p, msg)) === false && cond.match_message?.length) return false;
    if (cond.not_message?.some((p) => safeRegexTest(p, msg))) return false;
    if (cond.match_code?.some((p) => safeRegexTest(p, codeLine)) === false && cond.match_code?.length) return false;
    if (cond.not_code?.some((p) => safeRegexTest(p, codeLine))) return false;
    return true;
  };
  const lineStr = getUiString("line", "line");
  const inStr = getUiString("in", "in");
  const thisFileStr = getUiString("thisFile", "this file");
  const loc = trace.line && trace.file ? `${lineStr} ${trace.line} ${inStr} ${trace.file}` : trace.line ? `${lineStr} ${trace.line}` : trace.file || thisFileStr;
  const vars = {
    loc,
    name: trace.name || "",
    codeLine
  };
  const linePart = trace.line ? `<span class="pfem__line">${escapeHtml(lineStr)} ${escapeHtml(String(trace.line))}</span>` : null;
  const filePart = trace.file ? `<code class="pfem__file">${escapeHtml(trace.file)}</code>` : null;
  const htmlLoc = linePart && filePart ? `${linePart} ${escapeHtml(inStr)} ${filePart}` : linePart ?? filePart ?? escapeHtml(thisFileStr);
  const htmlTransforms = {
    name: (v) => `<code class="pfem__var">${escapeHtml(v)}</code>`,
    loc: (_) => htmlLoc,
    codeLine: (v) => `<code class="pfem__code">${escapeHtml(v)}</code>`
  };
  for (let i = 0; i < entry.variants.length; i++) {
    const v = entry.variants[i];
    if (!matches(v)) continue;
    const title = tmpl(v.title, vars);
    const summary = tmpl(v.summary, vars);
    const why = v.why ? tmpl(v.why, vars) : void 0;
    const steps = v.steps?.map((s) => tmpl(s, vars));
    const badges = v.badges;
    const titleHtml = tmpl(v.title, vars, htmlTransforms);
    const summaryHtml = tmpl(v.summary, vars, htmlTransforms);
    const whyHtml = v.why ? tmpl(v.why, vars, htmlTransforms) : void 0;
    const stepsHtml = v.steps?.map((s) => tmpl(s, vars, htmlTransforms));
    let patch = void 0;
    if (trace.type === "AttributeError" && /\.push\s*\(/i.test(codeLine)) {
      patch = codeLine.replace(/\.push\s*\(/i, ".append(");
    } else if (trace.type === "NameError" && trace.name && !/cannot access free variable|not associated with a value/i.test(trace.message || "")) {
      patch = `${trace.name} = 0
${codeLine}`;
    } else if (trace.type === "SyntaxError" && /^(if|for|while|def|class|elif|else|try|except|with)\b/i.test(codeLine) && !/:$/.test(codeLine.trim())) {
      const trimmedCodeLine = codeLine.replace(/\s*$/, "");
      patch = /,\s*$/.test(trimmedCodeLine) ? trimmedCodeLine.replace(/,\s*$/, ":") : trimmedCodeLine + ":";
    } else if (trace.type === "TypeError" && /\+\s*[A-Za-z_][A-Za-z0-9_]*/.test(codeLine)) {
      patch = codeLine.replace(/\+\s*([A-Za-z_][A-Za-z0-9_]*)/, "+ str($1)");
    }
    const has = (s) => !sections || sections.includes(s);
    const id = uniqueId();
    const lang = deck?.meta.language ?? "en";
    const inner = [
      has("title") ? `<p class="pfem__title" id="${id}-title">${titleHtml}</p>` : "",
      has("summary") ? `<p class="pfem__summary">${summaryHtml}</p>` : "",
      has("why") && whyHtml ? `<p class="pfem__why">${whyHtml}</p>` : "",
      has("steps") && stepsHtml?.length ? `<ul class="pfem__steps">${stepsHtml.map((s) => `<li>${s}</li>`).join("")}</ul>` : "",
      has("patch") && patch ? `<div class="pfem__patch"><p class="pfem__patch-label">${escapeHtml(getUiString("suggestedFix", "Suggested fix"))}</p><pre class="pfem__patch-code"><code>${escapeHtml(patch)}</code></pre></div>` : "",
      has("details") ? `<details class="pfem__details"><summary>${escapeHtml(getUiString("originalError", "Original error"))}</summary><pre><code>${escapeHtml(
        (trace.type || getUiString("error", "Error")) + ": " + trace.message
      )}</code></pre></details>` : ""
    ].filter(Boolean).join("\n");
    const labelledBy = has("title") ? ` aria-labelledby="${id}-title"` : "";
    const html = `<div class="pfem" role="group" lang="${escapeHtml(lang)}"${labelledBy}>
${inner}
</div>`;
    return {
      variantId: `${kind}/variants/${i}`,
      title,
      summary,
      why,
      steps,
      badges,
      patch,
      html
    };
  }
  return null;
};
var friendlyExplain = (opts) => {
  if (!state.copy) throw new Error("Copydeck not loaded");
  const code = opts.code;
  const trace = coerceTrace(opts.error, code, opts.runtime);
  if (!trace) return null;
  if (opts.file !== void 0) trace.file = opts.file;
  if (opts.line !== void 0) trace.line = opts.line;
  if (code && trace.line && (opts.line !== void 0 || !trace.codeLine)) {
    const lines = code.split(/\r?\n/);
    trace.codeLine = lines[trace.line - 1]?.trim();
    trace.codeBefore = lines.slice(Math.max(0, trace.line - 3), trace.line - 1);
    trace.codeAfter = lines.slice(trace.line, trace.line + 2);
  }
  const chosen = pickVariant(trace, code, opts.sections);
  if (!chosen) return null;
  return { trace, ...chosen };
};

// src/adapters/cpython.ts
var lastLineTypeMessage = (raw) => {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const tail = lines[lines.length - 1] || "";
  const m = tail.match(/^(\w+Error)\s*:\s*(.*)$/);
  return { type: m ? m[1] : null, message: m ? m[2] : tail, tail, lines };
};
var cpythonAdapter = (raw, code) => {
  const { type, message, tail, lines } = lastLineTypeMessage(raw);
  let file, line, col;
  for (const L of lines) {
    const mm = L.match(/File\s+"([^"]+)",\s+line\s+(\d+)/i);
    if (mm) {
      file = mm[1];
      line = parseInt(mm[2], 10);
    }
    const cc = L.match(/column\s+(\d+)/i);
    if (cc) col = parseInt(cc[1], 10);
  }
  if (!line) {
    const loc = tail.match(/\b(?:on|at)\s+line\s+(\d+)\s+(?:of|in)\s+([^\s:]+)\b/i);
    if (loc) {
      line = parseInt(loc[1], 10);
      file = loc[2];
    }
  }
  let name;
  const q = (message || "").match(/["']([^"']+)["']/);
  if (q) name = q[1];
  const hasStructuredSignal = Boolean(type || line || name);
  if (!hasStructuredSignal) return null;
  const t = {
    type,
    message,
    raw,
    file,
    line,
    col,
    frames: [],
    name,
    runtime: "unknown"
  };
  if (code && line) {
    const lines2 = code.split(/\r?\n/);
    t.codeLine = lines2[line - 1]?.trim();
    t.codeBefore = lines2.slice(Math.max(0, line - 3), line - 1);
    t.codeAfter = lines2.slice(line, line + 2);
  }
  return t;
};

// copydecks/en/copydeck.json
var copydeck_default = {
  meta: {
    language: "en",
    version: 1
  },
  glossaryForTranslators: {
    about: "Tokens written as {{token_name}} are filled in automatically at render time with real values from the Python error. You may move them to suit your language's word order, but do not translate, rename, or remove them. No HTML is needed around them as styling is applied automatically. Keys starting with _ are metadata for translators - do not translate or modify them.",
    tokens: {
      name: {
        description: "The Python variable or identifier that caused the error.",
        example: "score"
      },
      loc: {
        description: "The line number and filename where the error occurred.",
        example: "line 5 in main.py"
      },
      codeLine: {
        description: "The exact source code line that caused the error.",
        example: "for i in range(3)"
      }
    }
  },
  ui: {
    line: "line",
    in: "in",
    thisFile: "this file",
    originalError: "Original error",
    error: "Error",
    copydeckNotLoaded: "Copydeck not loaded",
    suggestedFix: "Suggested fix"
  },
  errors: {
    NameError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["cannot access free variable", "not associated with a value"]
          },
          title: "Variable used before it is given a value",
          summary: "The variable {{name}} is used at {{loc}} before it has been given a value. The code that gives it a value has not been run yet.",
          why: "You can only use a variable after it has been given a value. In nested functions (functions inside other functions), an inner function can only use a variable from the outer function if that value has already been set. To avoid this problem, give variables an initial value before using them elsewhere in your code.",
          steps: [
            "Give {{name}}a value before the inner function tries to use it."
          ],
          _placeholders: {
            name: "The enclosing-scope variable name, eg. total",
            loc: "Where it was used, eg. line 3 in main.py"
          }
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["is not defined"]
          },
          title: "Variable does not exist",
          summary: "The variable {{name}} is used at {{loc}} , but it does not exist.",
          why: "Python treats {{name}} as a variable. Before you can use a variable, you must give it a value. If you want the word {{name}} to appear as text, put it inside quotes.",
          steps: [
            "If {{name}} is meant to be text, put it in quotes.",
            "If {{name}} is meant to be a variable, create it before you use it.",
            "Check that the spelling and capital letters match everywhere you use {{name}}."
          ],
          _placeholders: {
            name: "The undefined variable name, eg. kittens",
            loc: "Where it was used, eg. line 2 in main.py"
          }
        }
      ]
    },
    UnboundLocalError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "Variable used before it is given a value",
          summary: "The variable {{name}} is being used on line {{loc}} before it has been given a value.",
          why: "You can only use a variable after it has been given a value. Here, your code is trying to use {{name}} but it does not have a value yet. If {{name}} is created inside another function, pass its value into this function before using it.",
          steps: [
            "Give {{name}} a value before the line that uses it."
          ],
          _placeholders: {
            name: "The variable used before assignment, eg. score",
            loc: "Where it was read before being set, eg. line 4 in main.py"
          }
        }
      ]
    },
    SyntaxError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["^(\\s*)(if|for|while|def|class|elif|else|try|except|with)\\b"],
            not_code: [":\\s*$", ",\\s*$"]
          },
          title: "Missing colon (:) at line end",
          summary: "A colon (:) is missing from the end of line {{loc}}.",
          why: "Some Python statements need a colon (:) at the end of the line. This includes if statements, for loops, while loops, and function definitions. Python uses the colon to show that a block of indented code follows.",
          steps: [
            "Add a colon (:) to the end of line {{loc}}."
          ],
          _placeholders: {
            loc: "Where the missing colon is, eg. line 3 in main.py",
            codeLine: "The line that needs the colon, eg. for i in range(10)"
          }
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["^(\\s*)(if|for|while|def|class|elif|else|try|except|with)\\b.*?,\\s*$"]
          },
          title: "Comma used where a colon (:) is needed",
          summary: "Line {{loc}} ends with a comma, but it should end with a colon (:).",
          why: "Some Python statements need a colon (:) at the end of the line. This includes if statements, for loops, while loops, and function definitions. Python uses the colon to show that a block of indented code follows. A comma cannot be used instead of a colon.",
          steps: [
            "Replace the comma at the end of line {{loc}} with a colon (:)."
          ],
          _placeholders: {
            loc: "Where the comma is, eg. line 1 in main.py",
            codeLine: "The line ending with a comma, eg. if score > 10,"
          }
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["^(\\s*)(if|for|while|def|class|elif|else|try|except|with)\\b.*::\\s*$"]
          },
          title: "Too many colons (:) at line end",
          summary: "Line {{loc}} ends with more than one colon. A single colon should be used.",
          why: "Some Python statements need a colon (:) at the end of the line. This includes if statements, for loops, while loops, and function definitions. These statements need exactly one colon. Extra colons will cause an error.",
          steps: [
            "Remove any extra colons at the end of line {{loc}} so that only one remains."
          ],
          _placeholders: {
            loc: "Where the extra colon is, eg. line 2 in main.py",
            codeLine: "The line with double colons, eg. if x > 0::"
          }
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["was never closed"]
          },
          title: "A bracket, brace, or parenthesis was not closed",
          summary: "One of your brackets, braces, or parentheses has an opening symbol but no matching closing symbol.",
          why: "Python expects every opening symbol to have a matching closing symbol: ( matches ), [ matches ], { matches }. If one is missing, Python cannot work out where the code should end.",
          steps: [
            "Find the opening symbol that does not have a matching closing symbol.",
            "Add the missing closing symbol.",
            "Check the lines above the error. The missing symbol may be earlier in your code."
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["does not match", "closing parenthesis", "closing bracket", "closing brace"]
          },
          title: "The closing bracket does not match the opening bracket",
          summary: "A closing symbol was used, but it does not match the opening symbol.",
          why: "Every opening symbol must be closed with the matching closing symbol: ( matches ), [ matches ], { matches }. For example, if you start with (, you must end with ). Using a different closing symbol will cause an error.",
          steps: [
            "Find the opening symbol.",
            "Check that the closing symbol matches it.",
            "Check that the symbols are in the correct order and that none are missing. If there are several pairs of brackets, start with the innermost pair and work outwards."
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["unterminated string literal", "EOL while scanning string literal"]
          },
          title: "A string was started but not finished",
          summary: "A piece of text starts with a quote mark but does not have a matching closing quote mark.",
          why: "In Python, text (called a string) must start and end with matching quote marks. If the closing quote mark is missing, Python cannot tell where the text ends.",
          steps: [
            "Find the text that starts with a quote mark but does not end with one.",
            "Add the missing quote mark.",
            `Check that the opening and closing quote marks match (" with " or ' with ').`
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_message: ["perhaps you forgot a comma"]
          },
          title: "A comma is missing between items",
          summary: "Python expected a comma between two items, but could not find one.",
          why: "When you put several items together, Python uses commas to separate them. If a comma is missing, Python cannot tell where one item ends and the next one begins. This often happens in lists, function calls, and other places where several values are grouped together.",
          steps: [
            "Look for two values that are next to each other without a comma between them.",
            "Add a comma between each separate item.",
            "Run your code again to check for any other problems."
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["^(\\s*)(if|elif|while)\\b.*="],
            not_code: ["==", "<=", ">=", "!="]
          },
          title: "Assignment used instead of comparison operator",
          summary: "This condition uses =, but conditions need == to compare values. Check line {{loc}} : {{codeLine}}.",
          why: "In Python, = and == do different jobs. = gives a variable a value, == checks whether two values are the same. Conditions in if, elif, and while statements must use == when checking for equality.",
          steps: [
            "Replace = with == if you want to compare two values."
          ],
          _placeholders: {
            loc: "Where the = is used in a condition, eg. line 6 in main.py",
            codeLine: "The condition line, eg. if score = 10:"
          }
        },
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["\\+\\+|--"]
          },
          title: "Operator is not valid in Python",
          summary: "Line {{loc}} contains ++ or --, but Python does not use these operators.",
          why: "In some programming languages, ++ increases a value by 1 and -- decreases a value by 1. Python does not use ++ or --. Instead, use += 1 to add 1 to a variable or -= 1 to subtract 1.",
          steps: [
            "Replace ++ with += 1 if you want to increase a value by 1.",
            "Replace -- with -= 1 if you want to decrease a value by 1."
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          title: "Something is missing or extra on this line",
          summary: "Something is missing or extra on this line, such as a colon, bracket, or quote mark.",
          why: "Python needs symbols like (), [], {}, :, and quotes to be used correctly. If one is missing, extra, or in the wrong place, Python may not be able to read the line.",
          steps: [
            "Check that (), [], and {} are in matching pairs.",
            "Add a missing colon (:) if the line needs one.",
            "Check that text starts and ends with matching quotes."
          ]
        }
      ]
    },
    IndentationError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "The indentation is not correct",
          summary: "The spaces at the start of the line do not match the code around it. Check line {{loc}} and the surrounding lines.",
          why: "Python uses spaces at the start of a line to show which lines belong together. Lines in the same block should start in the same place. A new block usually starts after a line ending with a colon (:). If the spaces are missing, or if there are too many, Python cannot work out which lines belong together.",
          steps: [
            "If a line is indented but the line above does not end with a colon (:), remove the extra spaces.",
            "If the line belongs inside a block, add the same indentation as the other lines in that block.",
            "Keep the indentation consistent. A common choice is 4 spaces for each level of indentation."
          ],
          _placeholders: {
            loc: "Where the indentation problem is, eg. line 7 in main.py"
          }
        }
      ]
    },
    TypeError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "These types of data cannot be joined",
          summary: "This code is trying to join (concatenate) different types of data, such as a number and some text.",
          why: "Python treats numbers and text differently. The + symbol can: add numbers together, join pieces of text together. Both sides of + must be the same type. For example, Python cannot add a number to text.",
          steps: [
            "If you want to join them as text, convert the number using str(...).",
            "If you want to add them as numbers, make sure neither value is text.",
            "If you are trying to print a string that contains one of more values, you can use an f-string."
          ]
        }
      ]
    },
    AttributeError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          if: {
            match_code: ["\\.push\\s*\\("],
            match_message: ["'push'"]
          },
          title: "Lists don't support that command",
          summary: "You're trying to use .push() with a list, but Python lists do not have a .push() command.",
          why: "Different programming languages use different commands for lists. Some languages use .push() to add an item to a list, but Python uses .append() instead. To add one item, use .append(). To add several items, use .extend().",
          steps: [
            "Use .append(value) to add one item to a list.",
            "Use .extend([item1, item2, ...]) to add several items at once."
          ]
        },
        {
          _lastReviewed: "2026-06-29",
          title: "That name cannot be used after the dot",
          summary: "At line {{loc}} in {{file}}, {{codeLine}} uses a name after the dot that cannot be used with this type of data.",
          why: "Different types of data have different names that can be used after a dot (.). Some of these are commands and some are values. For example, a list can use .append(), but a piece of text (a string) cannot. If Python cannot find the name after the dot, it may be spelled incorrectly or it may not work with this type of data.",
          steps: [
            "Check the spelling and capital letters of the name after the dot.",
            "Check that the data is the type you expect. For example, .append() works with lists, but not with text.",
            "Use a command that works with that type of data."
          ],
          _placeholders: {
            loc: "Where the attribute was used, eg. line 2 in main.py",
            codeLine: "The line with the dotted access, eg. name.shrink()"
          }
        }
      ]
    },
    IndexError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "This index position does not exist",
          summary: "You are trying to use an index position that is outside the list.",
          why: 'List indexes start at 0. The highest index value is one less than the length of the list. In this example:  my_list = ["A", "B", "C"], "A" is at index 0, "B" is at index 1, "C" is at index 2.',
          steps: [
            "Check how many items are in the list using len(my_list).",
            "Use an index that is smaller than the length of the list.",
            "Remember that the first item is at index 0, not index 1."
          ]
        }
      ]
    },
    KeyError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "The key isn't in the dictionary",
          summary: "You tried to use a key that the dictionary does not have.",
          why: "A dictionary stores values using keys. If you ask for a key that is not in the dictionary, Python cannot find a value for it.",
          steps: [
            "Check the spelling and capital letters of the key.",
            "Check that the key has been added to the dictionary.",
            "If the key might be missing, use .get(key, default) so your code has a backup value."
          ]
        }
      ]
    },
    ZeroDivisionError: {
      variants: [
        {
          _lastReviewed: "2026-06-29",
          title: "You can't divide by zero",
          summary: "This calculation is trying to divide a number by 0.",
          why: "In mathematics, dividing by zero is not possible, so Python cannot work out the answer. This error often happens when a variable that is being used as a divisor has the value 0.",
          steps: [
            "Find the number (or variable) after the / symbol.",
            "Check why that value is 0.",
            "Change the calculation so that you are not dividing by 0."
          ]
        }
      ]
    }
  }
};

// src/loaders.browser.ts
var bundledCopydecks = {
  en: copydeck_default
};
async function loadCopydeckFor(locale = "en", opts = {}) {
  const tryLocales = [locale];
  const baseLang = locale.split("-")[0];
  if (baseLang !== locale) tryLocales.push(baseLang);
  if (!tryLocales.includes("en")) tryLocales.push("en");
  for (const lang of tryLocales) {
    if (bundledCopydecks[lang]) {
      const deck = bundledCopydecks[lang];
      loadCopydeck(deck);
      return deck;
    }
  }
  if (opts.base) {
    const baseUrl = new URL(opts.base, window.location.origin);
    for (const lang of tryLocales) {
      try {
        const url = new URL(`${lang}/copydeck.json`, baseUrl).toString();
        const res = await fetch(url);
        if (res.ok) {
          const deck = await res.json();
          loadCopydeck(deck);
          return deck;
        }
      } catch {
      }
    }
  }
  throw new Error(`No copydeck found for ${tryLocales.join(", ")}`);
}
export {
  cpythonAdapter,
  friendlyExplain,
  loadCopydeck,
  loadCopydeckFor,
  registerAdapter
};
