// Runs inside the browser page (passed to page.evaluate), so it must be fully
// self-contained: no imports, no references to outer scope.
//
// Walks the rendered DOM and emits a scene graph of absolutely positioned
// nodes (FRAME / TEXT / IMAGE / SVG) with the visual styles Figma can express.

module.exports = function serializePage(opts) {
  opts = opts || {};
  const sx = window.scrollX;
  const sy = window.scrollY;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE',
  ]);

  // ---- images: collected by URL, fetched later by the Node side -------------
  const imageUrls = [];
  const imageIndex = new Map();
  function imageRef(url) {
    if (!url) return null;
    if (!imageIndex.has(url)) {
      imageIndex.set(url, imageUrls.length);
      imageUrls.push(url);
    }
    return imageIndex.get(url);
  }

  // ---- colors: normalise anything CSS can produce to {r,g,b,a} in 0..1 ------
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 1;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function color(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let c;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (m[4] && m[4].endsWith('%')) a /= 100;
      c = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: a };
    } else {
      // oklch(), color(), lab() etc. — let the canvas resolve it.
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      c = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    }
    if (c.a <= 0) c = null;
    colorCache.set(str, c);
    return c;
  }

  // Split on commas that are not inside parentheses.
  function splitTop(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const COLOR_RE = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b|\b[a-z]+\b)/i;

  function parseShadows(s) {
    if (!s || s === 'none') return [];
    return splitTop(s)
      .map(function (p) {
        const inset = /\binset\b/.test(p);
        const body = p.replace(/\binset\b/, '');
        const cm = body.match(COLOR_RE);
        const col = color(cm ? cm[0] : 'black');
        const nums = (body.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || []).map(parseFloat);
        return { inset: inset, color: col, x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0 };
      })
      .filter(function (s) { return s.color; });
  }

  function parseLinearGradient(s) {
    const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
    const parts = splitTop(inner);
    let angle = 180;
    const first = parts[0];
    if (/^-?[\d.]+(deg|turn|rad|grad)$/.test(first)) {
      const v = parseFloat(first);
      angle = first.endsWith('turn') ? v * 360 : first.endsWith('rad') ? (v * 180) / Math.PI : first.endsWith('grad') ? v * 0.9 : v;
      parts.shift();
    } else if (/^to /.test(first)) {
      const dir = first.slice(3);
      const map = {
        top: 0, right: 90, bottom: 180, left: 270,
        'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
        'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315,
      };
      angle = map[dir] !== undefined ? map[dir] : 180;
      parts.shift();
    }
    const stops = [];
    for (const p of parts) {
      const cm = p.match(COLOR_RE);
      if (!cm) continue;
      const col = color(cm[0]) || { r: 0, g: 0, b: 0, a: 0 };
      const pos = p.replace(cm[0], '').match(/-?[\d.]+%/);
      stops.push({ color: col, position: pos ? parseFloat(pos[0]) / 100 : null });
    }
    if (stops.length < 2) return null;
    // Fill in missing positions evenly between known ones.
    if (stops[0].position === null) stops[0].position = 0;
    if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].position !== null) continue;
      let j = i;
      while (stops[j].position === null) j++;
      const a = stops[i - 1].position;
      const b = stops[j].position;
      for (let k = i; k < j; k++) stops[k].position = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    stops.forEach(function (st) { st.position = Math.min(1, Math.max(0, st.position)); });
    return { kind: 'linear', angle: angle, stops: stops };
  }

  function parseBackgroundImages(cs) {
    const bi = cs.backgroundImage;
    if (!bi || bi === 'none') return [];
    const layers = [];
    const sizes = splitTop(cs.backgroundSize || 'auto');
    const repeats = splitTop(cs.backgroundRepeat || 'repeat');
    splitTop(bi).forEach(function (layer, i) {
      const url = layer.match(/^url\(["']?(.*?)["']?\)$/);
      if (url) {
        const size = sizes[i % sizes.length] || 'auto';
        const repeat = repeats[i % repeats.length] || 'repeat';
        let scaleMode = 'FILL';
        if (size === 'contain') scaleMode = 'FIT';
        else if (size === 'cover') scaleMode = 'FILL';
        else if (/repeat/.test(repeat) && repeat !== 'no-repeat' && size === 'auto') scaleMode = 'TILE';
        layers.push({ kind: 'image', image: imageRef(url[1]), scaleMode: scaleMode });
      } else if (/^linear-gradient\(/.test(layer)) {
        const g = parseLinearGradient(layer);
        if (g) layers.push(g);
      }
      // radial/conic/repeating gradients are not converted (yet).
    });
    return layers;
  }

  function px(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function radius(v, w, h) {
    if (!v) return 0;
    // Computed value may be "8px", "50%" or "8px 4px" (elliptical) — take the first.
    const first = v.split(' ')[0];
    let r = first.endsWith('%') ? (parseFloat(first) / 100) * Math.min(w, h) : px(first);
    return Math.max(0, Math.min(r, Math.min(w, h) / 2));
  }

  function boxStyle(cs, w, h) {
    const st = {};
    const bg = color(cs.backgroundColor);
    if (bg) st.background = bg;
    const layers = parseBackgroundImages(cs);
    if (layers.length) st.backgroundLayers = layers;

    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const widths = sides.map(function (s) {
      return cs['border' + s + 'Style'] === 'none' || cs['border' + s + 'Style'] === 'hidden' ? 0 : px(cs['border' + s + 'Width']);
    });
    if (widths.some(function (x) { return x > 0; })) {
      const idx = widths.findIndex(function (x) { return x > 0; });
      const bc = color(cs['border' + sides[idx] + 'Color']);
      if (bc) {
        st.border = {
          color: bc,
          top: widths[0], right: widths[1], bottom: widths[2], left: widths[3],
          dashed: /dashed|dotted/.test(cs['border' + sides[idx] + 'Style']),
        };
      }
    }

    const radii = [
      radius(cs.borderTopLeftRadius, w, h),
      radius(cs.borderTopRightRadius, w, h),
      radius(cs.borderBottomRightRadius, w, h),
      radius(cs.borderBottomLeftRadius, w, h),
    ];
    if (radii.some(function (r) { return r > 0; })) st.radius = radii;

    const shadows = parseShadows(cs.boxShadow);
    if (shadows.length) st.shadows = shadows;

    const op = parseFloat(cs.opacity);
    if (op < 1) st.opacity = op;

    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') st.clip = true;

    const blur = (cs.backdropFilter || '').match(/blur\(([\d.]+)px\)/);
    if (blur) st.backgroundBlur = parseFloat(blur[1]);
    const lblur = (cs.filter || '').match(/blur\(([\d.]+)px\)/);
    if (lblur) st.layerBlur = parseFloat(lblur[1]);

    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') st.blendMode = cs.mixBlendMode;
    return st;
  }

  function hasVisual(st) {
    return !!(st.background || st.backgroundLayers || st.border || st.shadows || st.clip ||
      st.opacity !== undefined || st.backgroundBlur || st.layerBlur || st.blendMode);
  }

  function fontOf(cs) {
    const size = px(cs.fontSize);
    const f = {
      family: cs.fontFamily,
      size: size,
      weight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
      color: color(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color) || color(cs.color),
      align: cs.textAlign,
    };
    if (cs.lineHeight !== 'normal') f.lineHeight = px(cs.lineHeight);
    if (cs.letterSpacing !== 'normal') f.letterSpacing = px(cs.letterSpacing);
    const deco = cs.textDecorationLine || '';
    if (deco.includes('underline')) f.decoration = 'UNDERLINE';
    else if (deco.includes('line-through')) f.decoration = 'STRIKETHROUGH';
    if (cs.textTransform === 'uppercase') f.textCase = 'UPPER';
    else if (cs.textTransform === 'lowercase') f.textCase = 'LOWER';
    else if (cs.textTransform === 'capitalize') f.textCase = 'TITLE';
    return f;
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    const label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    if (label) return tag + ' — ' + label.slice(0, 40);
    if (el.id) return tag + '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    // Skip utility-class soup (Tailwind etc.) — it is noise in a layer panel.
    const meaningful = cls.filter(function (c) { return !/[:[\]/]/.test(c) && c.length > 2; }).slice(0, 2);
    return meaningful.length ? tag + '.' + meaningful.join('.') : tag;
  }

  function rectOf(r) {
    return { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
  }

  function textNodeFor(tn, cs) {
    const pre = /^pre/.test(cs.whiteSpace) || cs.whiteSpace === 'break-spaces';
    let text = tn.textContent;
    if (!pre) text = text.replace(/\s+/g, ' ').trim();
    if (!text.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(tn);
    const r = range.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return null;
    const lines = new Set();
    for (const cr of range.getClientRects()) if (cr.width > 0) lines.add(Math.round(cr.top));
    return Object.assign(
      { type: 'TEXT', name: text.slice(0, 40), text: text, multiline: lines.size > 1 || pre && text.includes('\n') },
      rectOf(r),
      { font: fontOf(cs) }
    );
  }

  // Inline SVG: bake computed paint into attributes and resolve <use> refs so
  // figma.createNodeFromSvg renders it the way the browser did.
  const SVG_PAINT = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'stroke-linecap', 'stroke-linejoin', 'fill-rule'];
  function serializeSvg(svg, r) {
    const clone = svg.cloneNode(true);
    const src = [svg].concat(Array.from(svg.querySelectorAll('*')));
    const dst = [clone].concat(Array.from(clone.querySelectorAll('*')));
    for (let i = 0; i < src.length; i++) {
      const cs = getComputedStyle(src[i]);
      const decl = SVG_PAINT.map(function (p) {
        let v = cs.getPropertyValue(p);
        if (!v) return '';
        v = v.replace(/url\("?(#[^")]+)"?\)/, 'url($1)');
        return p + ':' + v;
      }).filter(Boolean);
      if (cs.display === 'none') decl.push('display:none');
      dst[i].setAttribute('style', decl.join(';'));
    }
    clone.querySelectorAll('use').forEach(function (u) {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      const g = document.createElementNS('http://www.w3.org/2000/svg', target.tagName === 'symbol' ? 'svg' : 'g');
      if (target.tagName === 'symbol') {
        if (target.getAttribute('viewBox')) g.setAttribute('viewBox', target.getAttribute('viewBox'));
        ['x', 'y', 'width', 'height'].forEach(function (a) { if (u.getAttribute(a)) g.setAttribute(a, u.getAttribute(a)); });
        Array.from(target.childNodes).forEach(function (c) { g.appendChild(c.cloneNode(true)); });
      } else {
        g.appendChild(target.cloneNode(true));
      }
      g.setAttribute('style', u.getAttribute('style') || '');
      u.replaceWith(g);
    });
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(r.width));
    clone.setAttribute('height', String(r.height));
    return new XMLSerializer().serializeToString(clone);
  }

  function controlText(el, cs) {
    const tag = el.tagName;
    let text = '';
    let placeholder = false;
    if (tag === 'SELECT') text = el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : '';
    else if (el.type === 'password' && el.value) text = '•'.repeat(el.value.length);
    else text = el.value;
    if (!text && el.placeholder) {
      text = el.placeholder;
      placeholder = true;
    }
    if (!text) return null;
    const r = el.getBoundingClientRect();
    const font = fontOf(cs);
    if (placeholder) font.color = color(getComputedStyle(el, '::placeholder').color) || font.color;
    const padL = px(cs.paddingLeft) + px(cs.borderLeftWidth);
    const padR = px(cs.paddingRight) + px(cs.borderRightWidth);
    const lh = font.lineHeight || font.size * 1.2;
    const isArea = tag === 'TEXTAREA';
    const y = isArea ? r.top + px(cs.paddingTop) + px(cs.borderTopWidth) : r.top + (r.height - lh) / 2;
    return {
      type: 'TEXT', name: placeholder ? 'placeholder' : 'value', text: text,
      multiline: isArea,
      x: r.left + sx + padL, y: y + sy,
      w: Math.max(1, r.width - padL - padR), h: isArea ? r.height - px(cs.paddingTop) - px(cs.paddingBottom) : lh,
      font: font, fixedWidth: true,
    };
  }

  let count = 0;
  const maxNodes = opts.maxNodes || 20000;

  function walk(el, out) {
    if (count > maxNodes) return;
    if (SKIP_TAGS.has(el.tagName)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;

    if (cs.display === 'contents') {
      walkChildren(el, cs, out);
      return;
    }

    const r = el.getBoundingClientRect();
    const box = rectOf(r);
    // Entirely off-canvas (off-screen menus, sr-only tricks).
    if (box.x + box.w < 0 || box.y + box.h < 0) return;
    if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return;

    const ownVisible = cs.visibility === 'visible';
    const tag = el.tagName;
    count++;

    // --- leaf replaced elements --------------------------------------------
    if (tag === 'IMG' || tag === 'PICTURE' && el.querySelector('img')) {
      const img = tag === 'IMG' ? el : el.querySelector('img');
      if (!ownVisible || box.w < 1 || box.h < 1) return;
      const fit = cs.objectFit;
      out.push(Object.assign({ type: 'IMAGE', name: nameOf(img) }, box, {
        image: imageRef(img.currentSrc || img.src),
        scaleMode: fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL',
        style: boxStyle(cs, box.w, box.h),
      }));
      return;
    }
    if (tag.toLowerCase() === 'svg') {
      if (!ownVisible || box.w < 0.5 || box.h < 0.5) return;
      out.push(Object.assign({ type: 'SVG', name: nameOf(el) }, box, {
        svg: serializeSvg(el, r), style: boxStyle(cs, box.w, box.h),
      }));
      return;
    }
    if (tag === 'CANVAS') {
      let data = null;
      try { data = el.toDataURL('image/png'); } catch (e) { /* tainted */ }
      out.push(Object.assign({ type: data ? 'IMAGE' : 'FRAME', name: 'canvas' }, box, {
        image: data ? imageRef(data) : undefined, scaleMode: 'FILL',
        style: data ? boxStyle(cs, box.w, box.h) : { background: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }, children: [],
      }));
      return;
    }
    if (tag === 'VIDEO' || tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
      if (box.w < 1 || box.h < 1) return;
      const poster = tag === 'VIDEO' && el.poster;
      out.push(Object.assign({ type: poster ? 'IMAGE' : 'FRAME', name: tag.toLowerCase() + ' (placeholder)' }, box, {
        image: poster ? imageRef(el.poster) : undefined, scaleMode: 'FILL',
        style: Object.assign(boxStyle(cs, box.w, box.h), poster ? {} : { background: { r: 0.12, g: 0.12, b: 0.14, a: 1 } }),
        children: [],
      }));
      return;
    }

    const node = Object.assign({ type: 'FRAME', name: nameOf(el) }, box, {
      style: ownVisible ? boxStyle(cs, box.w, box.h) : {},
      children: [],
    });
    const z = cs.position !== 'static' && cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) : 0;
    if (z) node.z = z;

    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      // Native controls have no CSS box styles; draw a simple stand-in.
      node.style = {
        background: el.checked ? { r: 0.15, g: 0.39, b: 0.92, a: 1 } : { r: 1, g: 1, b: 1, a: 1 },
        border: { color: { r: 0.55, g: 0.55, b: 0.6, a: 1 }, top: 1, right: 1, bottom: 1, left: 1 },
        radius: el.type === 'radio' ? [box.w / 2, box.w / 2, box.w / 2, box.w / 2] : [3, 3, 3, 3],
      };
      out.push(node);
      return;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (ownVisible) {
        const t = controlText(el, cs);
        if (t) node.children.push(t);
      }
      out.push(node);
      return;
    }

    walkChildren(el, cs, node.children);

    // Drop invisible, empty boxes.
    if (!node.children.length && !hasVisual(node.style)) return;
    if (box.w < 0.5 && box.h < 0.5 && !node.children.length) return;

    // Collapse pass-through wrappers (no visuals, single child) to keep the
    // layer tree readable.
    if (!opts.keepWrappers && !hasVisual(node.style) && node.children.length === 1 && !node.z) {
      out.push(node.children[0]);
      return;
    }
    out.push(node);
  }

  function walkChildren(el, cs, out) {
    const kids = [];
    const ownVisible = cs.visibility === 'visible';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!ownVisible) continue;
        const t = textNodeFor(child, cs);
        if (t) kids.push(t);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child, kids);
      }
    }
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) walk(child, kids);
    }
    // Approximate stacking order: positioned elements with z-index sort above.
    kids.forEach(function (k, i) { k._i = i; });
    kids.sort(function (a, b) { return (a.z || 0) - (b.z || 0) || a._i - b._i; });
    kids.forEach(function (k) { delete k._i; out.push(k); });
  }

  const doc = document.documentElement;
  const width = window.innerWidth;
  const height = opts.fullPage ? Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0) : window.innerHeight;

  const rootBg = color(getComputedStyle(document.body).backgroundColor) ||
    color(getComputedStyle(doc).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };

  const children = [];
  walk(document.body, children);

  return {
    title: document.title,
    url: location.href,
    width: width,
    height: height,
    background: rootBg,
    nodeCount: count,
    truncated: count > maxNodes,
    children: children,
    imageUrls: imageUrls,
  };
};
