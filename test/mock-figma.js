// Minimal stand-in for the Figma plugin API, strict enough to catch the
// mistakes Figma itself rejects (unloaded fonts, bad paint shapes, zero sizes).

function assert(cond, msg) {
  if (!cond) throw new Error('mock-figma: ' + msg);
}

function checkPaint(p) {
  if (p.type === 'SOLID') {
    assert(p.color && !('a' in p.color), 'SOLID color must be {r,g,b}');
    for (const k of ['r', 'g', 'b']) assert(p.color[k] >= 0 && p.color[k] <= 1, 'color out of range');
  } else if (p.type === 'GRADIENT_LINEAR') {
    assert(p.gradientTransform.length === 2 && p.gradientTransform.every((r) => r.length === 3 && r.every(Number.isFinite)), 'bad gradientTransform');
    assert(p.gradientStops.every((s) => 'a' in s.color && s.position >= 0 && s.position <= 1), 'bad gradient stop');
  } else if (p.type === 'IMAGE') {
    assert(typeof p.imageHash === 'string', 'image paint needs hash');
    assert(['FILL', 'FIT', 'CROP', 'TILE'].includes(p.scaleMode), 'bad scaleMode ' + p.scaleMode);
  } else {
    assert(false, 'unknown paint ' + p.type);
  }
}

function createMockFigma(fontList) {
  const loaded = new Set();
  const all = [];
  let id = 0;

  function base(type) {
    const n = {
      id: String(++id), type, name: type, x: 0, y: 0, width: 100, height: 100, children: [], parent: null,
      appendChild(c) { c.parent = this; this.children.push(c); },
      resize(w, h) {
        assert(w >= 0.01 && h >= 0.01 && Number.isFinite(w) && Number.isFinite(h), `resize(${w},${h})`);
        this.width = w; this.height = h;
      },
    };
    let fills = [];
    Object.defineProperty(n, 'fills', {
      get: () => fills,
      set: (v) => { v.forEach(checkPaint); fills = v; },
    });
    let strokes = [];
    Object.defineProperty(n, 'strokes', {
      get: () => strokes,
      set: (v) => { v.forEach(checkPaint); strokes = v; },
    });
    all.push(n);
    return n;
  }

  const figma = {
    _all: all,
    currentPage: Object.assign(base('PAGE'), { selection: [] }),
    viewport: { scrollAndZoomIntoView() {} },
    async listAvailableFontsAsync() {
      return fontList.map(([family, style]) => ({ fontName: { family, style } }));
    },
    async loadFontAsync(f) {
      assert(fontList.some(([a, b]) => a === f.family && b === f.style), `font not available: ${f.family} ${f.style}`);
      loaded.add(f.family + '|' + f.style);
    },
    createFrame() { return base('FRAME'); },
    createText() {
      const t = base('TEXT');
      let font = { family: 'Inter', style: 'Regular' };
      let chars = '';
      Object.defineProperty(t, 'fontName', {
        get: () => font,
        set: (f) => { assert(loaded.has(f.family + '|' + f.style), 'fontName set before loadFontAsync'); font = f; },
      });
      Object.defineProperty(t, 'characters', {
        get: () => chars,
        set: (c) => { assert(loaded.has(font.family + '|' + font.style), 'characters set with unloaded font'); chars = c; },
      });
      return t;
    },
    createNodeFromSvg(svg) {
      assert(/^<svg[\s>]/.test(svg) && svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'invalid svg');
      return base('FRAME');
    },
    createImage(bytes) {
      assert(bytes.length > 8, 'empty image');
      const png = bytes[0] === 0x89 && bytes[1] === 0x50;
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const gif = bytes[0] === 0x47 && bytes[1] === 0x49;
      assert(png || jpg || gif, 'unsupported image format');
      return { hash: 'h' + bytes.length + '_' + id++ };
    },
    base64Decode(s) { return Uint8Array.from(Buffer.from(s, 'base64')); },
  };
  return figma;
}

module.exports = { createMockFigma };
