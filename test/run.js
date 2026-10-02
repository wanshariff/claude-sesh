// End-to-end: serve a fixture page, capture it with the real CLI, then import
// the result through the plugin code against a strict mock Figma API.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createMockFigma } = require('./mock-figma');

const FIXTURES = path.join(__dirname, 'fixtures');
const OUT_DIR = path.join(__dirname, 'out');
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp' };

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
}

function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    // Simulates hotlink protection: only the browser's own image requests get through.
    if (req.url.startsWith('/protected.png')) {
      if (req.headers['sec-fetch-dest'] !== 'image') {
        res.writeHead(403);
        return res.end();
      }
      req.url = '/img.png';
    }
    const file = path.join(FIXTURES, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/page.html'));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/page.html`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'fixture.figma.json');

  try {
    // Async on purpose: a sync spawn would block this process's server.
    await new Promise((resolve, reject) => {
      const args = [path.join(__dirname, '..', 'capture', 'cli.js'), url, '--widths', '1280,390', '--wait', '200', '-o', out];
      const child = execFile(process.execPath, args, (err) => (err ? reject(err) : resolve()));
      child.stderr.pipe(process.stderr);
    });
  } finally {
    server.close();
  }

  // ---- capture assertions -------------------------------------------------
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  check(doc.format === 'web2figma' && doc.captures.length === 2, 'two captures (1280px, 390px)');
  const [desk, mobile] = doc.captures;
  check(desk.width === 1280 && mobile.width === 390, 'capture widths match viewports');
  check(mobile.height > desk.height, 'mobile capture is taller (responsive reflow)');

  const texts = [];
  const types = new Set();
  let gradient = null;
  let shadow = null;
  let roundAvatar = null;
  walk(desk.children, (n) => {
    types.add(n.type);
    if (n.type === 'TEXT') texts.push(n);
    const st = n.style || {};
    (st.backgroundLayers || []).forEach((l) => { if (l.kind === 'linear') gradient = l; if (l.kind === 'image') roundAvatar = n; });
    if (st.shadows && !st.shadows[0].inset) shadow = st.shadows[0];
  });
  const textOf = (s) => texts.find((t) => t.text === s);
  check(!!textOf('Ship designs that match production exactly'), 'heading text captured');
  check(textOf('Ship designs that match production exactly').multiline, 'wrapped heading marked multiline');
  check(textOf('Ship designs that match production exactly').font.size === 48, 'heading font size 48');
  check(textOf('Product') && textOf('Product').font.textCase === 'UPPER', 'text-transform → textCase');
  check(!textOf('Should not appear'), 'display:none skipped');
  check(!textOf('Screen reader only'), 'sr-only clipped text skipped');
  check(!!textOf('you@example.com'), 'input placeholder captured');
  check(gradient && gradient.angle === 135 && gradient.stops.length === 2, 'linear-gradient parsed');
  check(shadow && shadow.y === 4 && shadow.blur === 12 && Math.abs(shadow.color.a - 0.15) < 0.01, 'box-shadow parsed');
  check(roundAvatar && roundAvatar.style.radius[0] === 20, 'border-radius 50% → 20px');
  check(types.has('IMAGE') && types.has('SVG'), 'IMAGE and SVG nodes present');
  const svg = [];
  walk(desk.children, (n) => n.type === 'SVG' && svg.push(n));
  check(svg[0] && /fill:rgb\(106, 92, 255\)/.test(svg[0].svg), 'SVG currentColor baked to computed fill');
  check(Object.keys(doc.images).length === 4, 'four images captured (png, webp, data-uri svg, protected)');
  check(Object.values(doc.images).filter((i) => i.screenshot).length === 1, 'hotlink-protected image recovered via screenshot');
  const sigs = Object.values(doc.images).map((i) => Buffer.from(i.data, 'base64').subarray(0, 2).toString('hex'));
  check(sigs.every((s) => s === '8950' || s === 'ffd8' || s === '4749'), 'all images normalised to PNG/JPEG/GIF');

  // ---- plugin import against mock figma -----------------------------------
  global.figma = createMockFigma([
    ['Inter', 'Regular'], ['Inter', 'Medium'], ['Inter', 'Semi Bold'], ['Inter', 'Bold'], ['Inter', 'Italic'],
    ['Arial', 'Regular'], ['Arial', 'Bold'], ['Arial', 'Italic'],
  ]);
  delete require.cache[require.resolve('../figma-plugin/code.js')];
  const { importDocument } = require('../figma-plugin/code.js');
  const result = await importDocument(doc);
  check(result.frames === 2, 'plugin created 2 top-level frames');
  check(result.nodes > 30, `plugin built ${result.nodes} layers`);
  check(result.images === 4, 'plugin registered 4 images');
  check(result.svgFailures === 0 && result.textFailures === 0, 'no SVG/text failures');
  check(result.missingFonts.includes('Helvetica Neue'), 'missing font reported (Helvetica Neue → substituted)');
  const heading = figma._all.find((n) => n.type === 'TEXT' && n.characters === 'Ship designs that match production exactly');
  check(heading && heading.fontName.family === 'Arial' && heading.fontName.style === 'Bold', 'h1 resolved to Arial Bold');
  check(heading && heading.textAutoResize === 'HEIGHT', 'wrapped heading uses fixed width');
  const em = figma._all.find((n) => n.type === 'TEXT' && n.characters === 'italic');
  check(em && /Italic/.test(em.fontName.style), '<em> resolved to an italic style');

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
