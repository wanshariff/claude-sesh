#!/usr/bin/env node
// web2figma capture — render a live URL in Chromium and write a .figma.json
// scene that the Figma plugin (figma-plugin/) turns into editable layers.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const serializePage = require('./serialize');

const HELP = `
Usage: web2figma <url> [options]

Options
  -o, --out <file>         Output file (default: <host>.figma.json)
  -w, --widths <list>      Viewport widths to capture, comma-separated (default: 1440)
                           e.g. --widths 1440,768,390 for desktop/tablet/mobile frames
      --height <px>        Viewport height (default: 900)
      --viewport-only      Capture just the first screen instead of the full page
      --wait <ms>          Extra wait after load, for animations/data (default: 1000)
      --wait-for <css>     Wait until this selector is visible before capturing
      --auth <file>        Load cookies/localStorage saved with --save-auth
      --interactive        Open a visible browser; log in / click around, then press
                           Enter in the terminal to capture the current screen
      --save-auth <file>   (with --interactive) save the session for later --auth runs
      --keep-wrappers      Keep pass-through <div> wrappers instead of collapsing them
      --max-nodes <n>      Safety cap on captured elements (default: 20000)
  -h, --help               Show this help

Examples
  web2figma https://stripe.com --widths 1440,390
  web2figma https://app.example.com --interactive --save-auth auth.json
  web2figma https://app.example.com/settings --auth auth.json
`;

function parseArgs(argv) {
  const o = { widths: [1440], height: 900, wait: 1000, fullPage: true, maxNodes: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-o': case '--out': o.out = next(); break;
      case '-w': case '--widths': o.widths = next().split(',').map((s) => parseInt(s, 10)).filter(Boolean); break;
      case '--height': o.height = parseInt(next(), 10); break;
      case '--viewport-only': o.fullPage = false; break;
      case '--wait': o.wait = parseInt(next(), 10); break;
      case '--wait-for': o.waitFor = next(); break;
      case '--auth': o.auth = next(); break;
      case '--interactive': o.interactive = true; break;
      case '--save-auth': o.saveAuth = next(); break;
      case '--keep-wrappers': o.keepWrappers = true; break;
      case '--max-nodes': o.maxNodes = parseInt(next(), 10); break;
      default:
        if (a.startsWith('-')) fail(`Unknown option ${a}`);
        if (o.url) fail(`Unexpected argument ${a}`);
        o.url = a;
    }
  }
  return o;
}

function fail(msg) {
  console.error(`error: ${msg}\n${HELP}`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function settle(page, o) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (o.waitFor) await page.waitForSelector(o.waitFor, { state: 'visible', timeout: 30000 });
  // Scroll through the page so lazy-loaded images and scroll-triggered
  // reveals fire, then come back to the top.
  if (o.fullPage) {
    await page.evaluate(async () => {
      const step = Math.max(200, window.innerHeight * 0.8);
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(o.wait);
  // Jump running animations/transitions to their end state so we capture the
  // settled design, not a mid-fade frame.
  await page.evaluate(() => {
    for (const a of document.getAnimations ? document.getAnimations() : []) {
      try {
        if (a.effect && a.effect.getComputedTiming().iterations === Infinity) a.pause();
        else a.finish();
      } catch (e) { /* ignore */ }
    }
    window.scrollTo(0, 0);
  });
}

const SUPPORTED = (buf) =>
  (buf[0] === 0x89 && buf[1] === 0x50) || // PNG
  (buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
  (buf[0] === 0x47 && buf[1] === 0x49); // GIF

// Figma accepts PNG/JPEG/GIF up to 4096px. Anything else (WebP, AVIF, SVG) or
// anything larger is rasterised to PNG in a blank page (no site CSP to fight).
async function normaliseImage(helper, buf, mime) {
  const b64 = buf.toString('base64');
  const res = await helper.evaluate(
    async ({ b64, mime, supported }) => {
      const img = new Image();
      img.src = `data:${mime || 'image/png'};base64,${b64}`;
      try { await img.decode(); } catch (e) { return { error: 'decode failed' }; }
      let w = img.naturalWidth || 300;
      let h = img.naturalHeight || 150;
      const isSvg = /svg/.test(mime);
      if (supported && w <= 4096 && h <= 4096) return { keep: true, w, h };
      const scale = Math.min(isSvg ? 2 : 1, 4096 / w, 4096 / h);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { data: c.toDataURL('image/png').split(',')[1], w, h };
    },
    { b64, mime, supported: SUPPORTED(buf) }
  );
  if (res.error) return null;
  return { data: res.keep ? b64 : res.data, width: res.w, height: res.h };
}

// Fallback for images the server won't hand out directly (hotlink
// protection, signed/expired URLs): screenshot the rendered <img> instead.
async function screenshotImage(page, url) {
  const handle = await page.evaluateHandle((u) => {
    return Array.from(document.images).find((img) => (img.currentSrc || img.src) === u && img.complete && img.naturalWidth > 0) || null;
  }, url);
  const el = handle.asElement();
  if (!el) return null;
  const box = await el.boundingBox();
  if (!box || box.width < 1 || box.height < 1) return null;
  const buf = await el.screenshot({ animations: 'disabled', timeout: 10000 });
  return { data: buf.toString('base64'), width: Math.round(box.width), height: Math.round(box.height), screenshot: true };
}

async function fetchImages(context, page, urls, referer) {
  const helper = await context.newPage();
  const out = {};
  let failed = 0;
  await Promise.all(
    urls.map(async (url, i) => {
      try {
        let buf;
        let mime = '';
        if (url.startsWith('data:')) {
          const m = url.match(/^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s);
          if (!m) throw new Error('malformed data URL');
          mime = m[1];
          buf = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
        } else {
          const res = await context.request.get(url, { headers: { referer }, timeout: 20000 });
          if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
          buf = await res.body();
          mime = (res.headers()['content-type'] || '').split(';')[0];
        }
        const img = await normaliseImage(helper, buf, mime);
        if (!img) throw new Error('could not decode');
        out[i] = img;
      } catch (e) {
        if (process.env.DEBUG) log(`  image fetch failed: ${url.slice(0, 100)} (${e.message})`);
        out[i] = null;
      }
    })
  );
  // Screenshots must run one at a time (they scroll the page).
  for (let i = 0; i < urls.length; i++) {
    if (out[i]) continue;
    const shot = await screenshotImage(page, urls[i]).catch(() => null);
    if (shot) out[i] = shot;
    else {
      delete out[i];
      failed++;
    }
  }
  await helper.close();
  return { images: out, failed };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(HELP);
  if (!o.url && !o.interactive) fail('A URL is required.');
  if (o.url && !/^[a-z]+:\/\//i.test(o.url)) o.url = 'https://' + o.url;

  const browser = await chromium.launch({ headless: !o.interactive });
  const context = await browser.newContext({
    viewport: { width: o.widths[0], height: o.height },
    deviceScaleFactor: 1,
    storageState: o.auth ? o.auth : undefined,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    if (o.url) {
      log(`Loading ${o.url}`);
      await page.goto(o.url, { waitUntil: 'load', timeout: 60000 });
    }
    if (o.interactive) {
      await waitForEnter('\nBrowser is open. Log in / navigate to the screen you want, then press Enter here to capture... ');
      if (o.saveAuth) {
        await context.storageState({ path: o.saveAuth });
        log(`Saved session to ${o.saveAuth} (keep it private — it contains your cookies).`);
      }
    }

    const captures = [];
    const allUrls = [];
    const urlIndex = new Map();

    for (const width of o.widths) {
      await page.setViewportSize({ width, height: o.height });
      log(`Capturing ${width}px…`);
      await settle(page, o);
      const scene = await page.evaluate(serializePage, {
        fullPage: o.fullPage, keepWrappers: o.keepWrappers, maxNodes: o.maxNodes,
      });
      if (scene.truncated) log(`  warning: hit --max-nodes ${o.maxNodes}; page was truncated`);

      // Re-key per-capture image indices into one shared table.
      const remap = scene.imageUrls.map((u) => {
        if (!urlIndex.has(u)) { urlIndex.set(u, allUrls.length); allUrls.push(u); }
        return urlIndex.get(u);
      });
      const fix = (n) => {
        if (typeof n.image === 'number') n.image = remap[n.image];
        if (n.style && n.style.backgroundLayers) {
          n.style.backgroundLayers.forEach((l) => { if (typeof l.image === 'number') l.image = remap[l.image]; });
        }
        (n.children || []).forEach(fix);
      };
      scene.children.forEach(fix);
      delete scene.imageUrls;
      scene.label = `${width}px`;
      captures.push(scene);
      log(`  ${scene.nodeCount} elements, ${scene.width}×${Math.round(scene.height)}`);
    }

    log(`Fetching ${allUrls.length} image(s)…`);
    const { images, failed } = await fetchImages(context, page, allUrls, page.url());
    if (failed) log(`  ${failed} image(s) could not be fetched; they will import as grey boxes (DEBUG=1 for details)`);

    const doc = {
      format: 'web2figma',
      version: 1,
      source: page.url(),
      capturedAt: new Date().toISOString(),
      captures,
      images,
    };
    const host = (() => { try { return new URL(page.url()).hostname.replace(/^www\./, ''); } catch (e) { return 'capture'; } })();
    const out = o.out || `${host || 'capture'}.figma.json`;
    fs.writeFileSync(out, JSON.stringify(doc));
    const mb = (fs.statSync(out).size / 1e6).toFixed(1);
    log(`\nWrote ${path.resolve(out)} (${mb} MB)`);
    log('Import it in Figma: Plugins → Development → Web → Figma Importer.');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
