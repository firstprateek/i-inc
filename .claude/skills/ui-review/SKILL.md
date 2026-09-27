---
name: ui-review
description: Review any i.inc UI for generic "AI slop" tells and render it in Chromium to catch misalignment, overlap, clipping, overflow and contrast. Use whenever you build or change UI in this repo (apps/web Lit components, design canvases and artboards, HTML mockups or artifacts) and before calling UI work done.
---

# UI review

Two passes, in this order. Both are required before UI work is called done.

## 1. Read the UI against the tells

Go through `references/ten-tells.md` and `references/i-inc-lessons.md` for every screen you touched.
The lessons file is what went wrong in i.inc before; check those first.

- Judge each tell in context. A tell is a question ("does this colour mean anything?"), not a ban.
- Only report what the screen actually shows. Say which element, what's wrong, and the fix.
- Fix the structure before swapping the skin: roles, hierarchy and content first, then colour and type.

## 2. Render it and run the checker

```sh
node tools/ui-check/check.mjs --out ui-check-out <file.html | url> ...
```

It renders each page in Chromium (Playwright, with Chrome DevTools Protocol checks), saves a
screenshot, and reports:

| Kind | Level | Meaning |
| --- | --- | --- |
| overlap | error | two visible text/icon/control elements intersect |
| covered | error | another element paints over text, or text is still under a fixed bar at the end of the page |
| overflow | error / warn | text outside its box, or spilling into the padding (usually an unplanned wrap) |
| contrast | error | text below WCAG AA (4.5:1, or 3:1 for large text) against its real background |
| name | error | a button or link with no accessible name (CDP accessibility tree) |
| clipped | warn | cut off by an ancestor with overflow hidden |
| near-miss | warn | siblings 1–3 px off a shared edge (or centre, in a centred row): almost aligned, so probably a slip |
| sparse | warn | a card in a grid whose content ends before 60% of its height |
| target | warn | a control smaller than 44 px both ways |
| font | warn | a declared web font didn't load, so the render (and the check) used a fallback |
| sideways | error | the page is wider than the viewport, so it scrolls sideways |

Then **look at every screenshot yourself**. The checker can't see decorative shapes colliding (a
monitor drawn over an avatar), awkward wrapping inside a box that still fits, or empty space that
isn't in a grid. Report errors as blocking; judge warnings.

- It checks inside open shadow roots, so Lit components are measured, not just the page shell.
- Design artboards (`*.dc.html`) render as plain HTML; the viewport is sized to the artboard's
  fixed-width root. For the web app, pass the dev server's URL and `--size`, once per breakpoint
  (at least 390x844 and 1440x900).
- A `font` warning means the other findings were measured with the wrong font: fix loading first.
- Chromium comes from Playwright. Until the workspace has it as a dev dependency, the script falls
  back to the global install. Behind this environment's TLS proxy it fetches HTTPS from the Node
  side (certificates still verified), so web fonts load.

## 3. Record what you learned

When a review finds a new kind of mistake, add it to `references/i-inc-lessons.md` in the same
change, with the rule that prevents it. If the checker could have caught it, extend
`tools/ui-check/check.mjs` too.
