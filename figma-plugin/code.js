// Web → Figma Importer
// Rebuilds a web2figma capture (.figma.json) as editable Figma layers.

const STYLE_WEIGHTS = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

const GENERIC_FALLBACKS = {
  'sans-serif': ['Inter', 'Roboto', 'Arial'],
  'system-ui': ['SF Pro Text', 'Inter', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'Inter'],
  'blinkmacsystemfont': ['SF Pro Text', 'Inter'],
  'ui-sans-serif': ['Inter'],
  'segoe ui': ['Segoe UI', 'Inter'],
  'serif': ['Georgia', 'Times New Roman', 'Noto Serif', 'Inter'],
  'ui-serif': ['Georgia', 'Noto Serif'],
  'monospace': ['Roboto Mono', 'Source Code Pro', 'Courier New'],
  'ui-monospace': ['SF Mono', 'Roboto Mono', 'Source Code Pro'],
};

const DEFAULT_FONT = { family: 'Inter', style: 'Regular' };

function styleWeight(style) {
  for (const [re, w] of STYLE_WEIGHTS) if (re.test(style)) return w;
  return 400;
}

function createFontResolver(available) {
  // family (lowercase) -> { family, styles: [{style, weight, italic}] }
  const index = new Map();
  for (const f of available) {
    const key = f.fontName.family.toLowerCase();
    if (!index.has(key)) index.set(key, { family: f.fontName.family, styles: [] });
    index.get(key).styles.push({
      style: f.fontName.style,
      weight: styleWeight(f.fontName.style),
      italic: /italic|oblique/i.test(f.fontName.style),
    });
  }
  const cache = new Map();
  const loaded = new Map();
  const missing = new Set();

  function pick(familyList, weight, italic) {
    const families = (familyList || '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    const candidates = [];
    for (const f of families) {
      candidates.push(f);
      const g = GENERIC_FALLBACKS[f.toLowerCase()];
      if (g) candidates.push(...g);
    }
    candidates.push('Inter');
    if (families[0] && !index.has(families[0].toLowerCase()) && !GENERIC_FALLBACKS[families[0].toLowerCase()]) {
      missing.add(families[0]);
    }
    for (const c of candidates) {
      const entry = index.get(c.toLowerCase());
      if (!entry) continue;
      let best = null;
      let bestScore = Infinity;
      for (const s of entry.styles) {
        const score = Math.abs(s.weight - weight) + (s.italic !== italic ? 1000 : 0) +
          (/condensed|narrow|expanded|display/i.test(s.style) ? 50 : 0);
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (best) return { family: entry.family, style: best.style };
    }
    return DEFAULT_FONT;
  }

  return {
    missing,
    async resolve(familyList, weight, italic) {
      const key = familyList + '|' + weight + '|' + italic;
      if (!cache.has(key)) cache.set(key, pick(familyList, weight, italic));
      let font = cache.get(key);
      const fk = font.family + '|' + font.style;
      if (!loaded.has(fk)) loaded.set(fk, figma.loadFontAsync(font).then(() => true, () => false));
      if (!(await loaded.get(fk))) {
        font = DEFAULT_FONT;
        await figma.loadFontAsync(font);
      }
      return font;
    },
  };
}

function rgb(c) {
  return { r: c.r, g: c.g, b: c.b };
}

function solid(c) {
  return { type: 'SOLID', color: rgb(c), opacity: c.a === undefined ? 1 : c.a };
}

// CSS linear-gradient angle → Figma gradientTransform (node unit space →
// gradient space, where the gradient runs along x from 0 to 1).
function gradientPaint(layer, w, h) {
  const t = (layer.angle * Math.PI) / 180;
  const sin = Math.sin(t);
  const cos = Math.cos(t);
  const len = Math.abs(w * sin) + Math.abs(h * cos) || 1;
  const a = (w * sin) / len;
  const b = (-h * cos) / len;
  const c = -b;
  const d = a;
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [
      [a, b, 0.5 - 0.5 * a - 0.5 * b],
      [c, d, 0.5 - 0.5 * c - 0.5 * d],
    ],
    gradientStops: layer.stops.map((s) => ({
      position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    })),
  };
}

const BLEND = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

function createImporter(doc, fonts, onProgress) {
  const hashes = new Map();
  const stats = { nodes: 0, images: 0, svgFailures: 0, textFailures: 0 };

  function imageHash(id) {
    if (id === undefined || id === null) return null;
    if (hashes.has(id)) return hashes.get(id);
    let hash = null;
    const img = doc.images && doc.images[id];
    if (img) {
      try {
        hash = figma.createImage(figma.base64Decode(img.data)).hash;
        stats.images++;
      } catch (e) { hash = null; }
    }
    hashes.set(id, hash);
    return hash;
  }

  function fillsFor(style, w, h) {
    const fills = [];
    if (style.background) fills.push(solid(style.background));
    // CSS lists background layers top-first; Figma paints are bottom-first.
    const layers = (style.backgroundLayers || []).slice().reverse();
    for (const l of layers) {
      if (l.kind === 'image') {
        const hash = imageHash(l.image);
        if (hash) fills.push({ type: 'IMAGE', imageHash: hash, scaleMode: l.scaleMode || 'FILL' });
      } else if (l.kind === 'linear') {
        fills.push(gradientPaint(l, w, h));
      }
    }
    return fills;
  }

  function applyBox(node, n, extraFills) {
    const st = n.style || {};
    node.fills = fillsFor(st, n.w, n.h).concat(extraFills || []);

    if (st.border) {
      const b = st.border;
      node.strokes = [solid(b.color)];
      node.strokeAlign = 'INSIDE';
      if (b.top === b.right && b.top === b.bottom && b.top === b.left) {
        node.strokeWeight = b.top;
      } else {
        node.strokeTopWeight = b.top;
        node.strokeRightWeight = b.right;
        node.strokeBottomWeight = b.bottom;
        node.strokeLeftWeight = b.left;
      }
      if (b.dashed) {
        const wgt = Math.max(b.top, b.right, b.bottom, b.left) || 1;
        node.dashPattern = [wgt * 3, wgt * 2];
      }
    }

    if (st.radius) {
      node.topLeftRadius = st.radius[0];
      node.topRightRadius = st.radius[1];
      node.bottomRightRadius = st.radius[2];
      node.bottomLeftRadius = st.radius[3];
    }

    const effects = [];
    for (const s of st.shadows || []) {
      const e = {
        type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
        offset: { x: s.x, y: s.y },
        radius: s.blur,
        spread: s.spread,
        visible: true,
        blendMode: 'NORMAL',
      };
      if (!s.inset) e.showShadowBehindNode = false;
      effects.push(e);
    }
    if (st.backgroundBlur) effects.push({ type: 'BACKGROUND_BLUR', radius: st.backgroundBlur, visible: true });
    if (st.layerBlur) effects.push({ type: 'LAYER_BLUR', radius: st.layerBlur, visible: true });
    if (effects.length) node.effects = effects;

    if (st.opacity !== undefined) node.opacity = st.opacity;
    if (st.blendMode && BLEND[st.blendMode]) node.blendMode = BLEND[st.blendMode];
    node.clipsContent = !!st.clip;
  }

  const ALIGN = { left: 'LEFT', start: 'LEFT', center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' };

  async function buildText(n) {
    const f = n.font;
    const t = figma.createText();
    t.name = n.name || 'Text';
    t.fontName = await fonts.resolve(f.family, f.weight, f.italic);
    t.characters = n.text;
    t.fontSize = Math.max(1, f.size);
    if (f.color) t.fills = [solid(f.color)];
    t.lineHeight = f.lineHeight ? { value: f.lineHeight, unit: 'PIXELS' } : { unit: 'AUTO' };
    if (f.letterSpacing) t.letterSpacing = { value: f.letterSpacing, unit: 'PIXELS' };
    if (f.decoration) t.textDecoration = f.decoration;
    if (f.textCase) t.textCase = f.textCase;
    t.textAlignHorizontal = ALIGN[f.align] || 'LEFT';
    if (n.multiline || n.fixedWidth) {
      t.textAutoResize = 'HEIGHT';
      // A pixel of slack absorbs font-metric differences that would
      // otherwise cause an extra wrap.
      t.resize(Math.max(1, n.w + 1), Math.max(1, n.h));
    } else {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      if (t.textAlignHorizontal !== 'LEFT') t.textAlignHorizontal = 'LEFT';
    }
    return t;
  }

  async function build(n, parent, ox, oy) {
    let node;
    if (n.type === 'TEXT') {
      try {
        node = await buildText(n);
      } catch (e) {
        stats.textFailures++;
        return;
      }
    } else if (n.type === 'SVG') {
      try {
        node = figma.createNodeFromSvg(n.svg);
        node.name = n.name || 'svg';
        node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
        node.clipsContent = false;
        const st = n.style || {};
        if (st.opacity !== undefined) node.opacity = st.opacity;
      } catch (e) {
        stats.svgFailures++;
        node = figma.createFrame();
        node.name = (n.name || 'svg') + ' (unsupported)';
        node.fills = [];
        node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
      }
    } else {
      node = figma.createFrame();
      node.name = n.name || 'Frame';
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
      let extra = [];
      if (n.type === 'IMAGE') {
        const hash = imageHash(n.image);
        extra = hash
          ? [{ type: 'IMAGE', imageHash: hash, scaleMode: n.scaleMode || 'FILL' }]
          : [{ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.9 } }];
      }
      applyBox(node, n, extra);
    }

    parent.appendChild(node);
    node.x = n.x - ox;
    node.y = n.y - oy;

    stats.nodes++;
    if (stats.nodes % 150 === 0) {
      onProgress(stats.nodes);
      // Yield so the UI can repaint the progress bar.
      await new Promise((r) => setTimeout(r, 0));
    }

    if (n.type === 'FRAME' && n.children) {
      for (const c of n.children) await build(c, node, n.x, n.y);
    }
  }

  async function buildCapture(cap, x, y) {
    const root = figma.createFrame();
    let host = cap.url;
    try { host = new URL(cap.url).host; } catch (e) { /* keep url */ }
    root.name = (cap.title || host) + ' — ' + cap.label;
    root.resize(Math.max(1, cap.width), Math.max(1, Math.round(cap.height)));
    root.fills = [solid(cap.background || { r: 1, g: 1, b: 1, a: 1 })];
    root.clipsContent = true;
    root.x = x;
    root.y = y;
    figma.currentPage.appendChild(root);
    for (const c of cap.children) await build(c, root, 0, 0);
    return root;
  }

  return { buildCapture, stats };
}

async function importDocument(doc, onProgress) {
  if (!doc || doc.format !== 'web2figma') throw new Error('This is not a web2figma capture file.');
  const fonts = createFontResolver(await figma.listAvailableFontsAsync());
  await figma.loadFontAsync(DEFAULT_FONT);
  const importer = createImporter(doc, fonts, onProgress || function () {});

  // Place new frames to the right of whatever is already on the page.
  let x = 0;
  const y = 0;
  for (const n of figma.currentPage.children) x = Math.max(x, n.x + n.width + 200);

  const roots = [];
  for (const cap of doc.captures) {
    const root = await importer.buildCapture(cap, x, y);
    roots.push(root);
    x += root.width + 200;
  }
  figma.currentPage.selection = roots;
  figma.viewport.scrollAndZoomIntoView(roots);
  return {
    frames: roots.length,
    nodes: importer.stats.nodes,
    images: importer.stats.images,
    svgFailures: importer.stats.svgFailures,
    textFailures: importer.stats.textFailures,
    missingFonts: Array.from(fonts.missing),
  };
}

if (typeof figma !== 'undefined' && typeof __html__ !== 'undefined') {
  figma.showUI(__html__, { width: 360, height: 440, themeColors: true });
  figma.ui.onmessage = async (msg) => {
    if (msg.type === 'import') {
      try {
        const result = await importDocument(msg.doc, (n) => figma.ui.postMessage({ type: 'progress', nodes: n }));
        figma.ui.postMessage({ type: 'done', result });
        figma.notify(`Imported ${result.nodes} layers into ${result.frames} frame(s)`);
      } catch (e) {
        figma.ui.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
      }
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  };
}

if (typeof module !== 'undefined') module.exports = { importDocument, gradientPaint, styleWeight };
