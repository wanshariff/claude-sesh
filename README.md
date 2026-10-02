# web2figma

Convert a live website or web app into **editable Figma layers**: frames, text, images and vectors, not a flat screenshot.

Two parts:

| Part | What it does |
|---|---|
| `capture/` — CLI | Opens the URL in headless Chromium, waits for it to settle, walks the rendered DOM and writes a `.figma.json` scene (positions, computed styles, text, images, inline SVG). |
| `figma-plugin/` — Figma plugin | Reads the `.figma.json` and rebuilds it on the current page, one top-level frame per viewport width. |

Why a CLI and not a pure plugin: Figma plugins can't render a third-party page, so the capture has to happen in a real browser. Doing it in Playwright also means it works behind logins.

## Quick start

```bash
npm install
npx playwright install chromium        # first time only

# Marketing site, desktop + mobile frames
npm run capture -- https://example.com --widths 1440,390
```

Then in **Figma desktop**: *Plugins → Development → Import plugin from manifest…* → pick `figma-plugin/manifest.json`. Run **Web → Figma Importer**, drop the `.figma.json` file in, and click **Import**.

## Capturing a logged-in web app

```bash
# 1. Opens a visible browser. Log in, navigate to the screen, press Enter in the terminal.
npm run capture -- https://app.example.com --interactive --save-auth auth.json

# 2. Re-use the session headlessly for other screens
npm run capture -- https://app.example.com/settings --auth auth.json --widths 1440
npm run capture -- https://app.example.com/billing  --auth auth.json --wait-for "[data-loaded]"
```

`auth.json` contains your session cookies. It's git-ignored, so don't share it.

## Options

```
-o, --out <file>         Output file (default: <host>.figma.json)
-w, --widths <list>      Viewport widths, comma-separated (default: 1440)
    --height <px>        Viewport height (default: 900)
    --viewport-only      First screen only, not the full scroll height
    --wait <ms>          Extra settle time after load (default: 1000)
    --wait-for <css>     Wait for a selector before capturing
    --auth <file>        Load a saved session
    --interactive        Visible browser; capture when you press Enter
    --save-auth <file>   Save the session after an interactive capture
    --keep-wrappers      Keep style-less <div> wrappers (collapsed by default)
    --max-nodes <n>      Safety cap on elements (default: 20000)
```

## What converts

| Web | Figma |
|---|---|
| Element boxes | Frames, nested like the DOM, with clip content when `overflow` ≠ visible |
| `background-color`, `linear-gradient()`, `background-image: url()` | Solid, linear gradient and image fills (stacked in CSS order) |
| `border` (per side, dashed) | Inside strokes with per-side weights and a dash pattern |
| `border-radius` (per corner, %) | Per-corner radius |
| `box-shadow` (incl. inset, multiple) | Drop and inner shadows |
| `opacity`, `mix-blend-mode`, `filter`/`backdrop-filter: blur()` | Layer opacity, blend mode, layer and background blur |
| Text | Text layers with font, weight, italic, size, line height, letter spacing, colour, alignment, underline/strikethrough, `text-transform` → text case. Wrapped text keeps its width. |
| `<img>`, `<picture>`, `<canvas>`, video posters | Image fills (`object-fit` → Fill/Fit). WebP, AVIF and SVG are converted to PNG. Hotlink-protected images fall back to an element screenshot. |
| Inline `<svg>` (incl. `<use>` sprites, `currentColor`) | Editable vector layers |
| Inputs, selects, textareas | Box + value/placeholder text. Checkboxes and radios become simple stand-ins. |

Fonts: the plugin picks the first font in the CSS `font-family` stack that's installed in Figma, at the nearest weight. If it falls back, it tells you which fonts are missing so you can install them and re-import.

## Known limitations

These are worth knowing before you rely on the output for handoff:

- **Absolute positioning, no auto layout.** The layout is pixel-accurate but static. It's a good base for redesign or audit work. It is not a component library.
- **No components or variables.** Repeated cards come in as separate frames. Turning them into components and tokens is still a manual (or follow-up) step.
- **Not converted:** `::before`/`::after` content (this includes icon fonts), radial/conic gradients, CSS transforms beyond their bounding box, cross-origin iframes (placeholder box), and video frames.
- **Stacking order** is approximated from DOM order plus `z-index`. Overlapping, positioned UI like dropdowns and modals can occasionally land under a sibling.
- The capture is a **single state**. To get hover, open-menu or empty states, use `--interactive` and capture each one.

## Development

```bash
npm test
```

The test serves `test/fixtures/page.html`, runs the real CLI at two widths, then imports the result through `figma-plugin/code.js` against a strict mock of the Figma plugin API. The mock rejects unloaded fonts, bad paint shapes and unsupported image formats.
