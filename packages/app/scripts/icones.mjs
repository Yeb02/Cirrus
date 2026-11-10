// The app's icons (plan 9, D3): build/icon.ico (« Cirrus ») and build/icon-dev.ico (« Cirrus Dev », marked « DEV »),
// drawn from the SVG below at 16, 32, 48 and 256 px by Chromium — a hidden window of Electron: no dependency, nothing
// shown — and written as ICO files the way Windows' own are: 32-bit bitmaps up to 48 px, a PNG at 256 px.
// node scripts/icones.mjs (npm run icones): run with Node, the script starts itself again under Electron, like
// compare-captures.mjs. The .ico files are committed; this runs again only when the drawing changes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const SIZES = [16, 32, 48, 256];
// The app's colours (renderer/styles.css): its night sky, its ink; « DEV » on an orange band.
const SKY_TOP = '#1d2f52', SKY = '#0a1120', INK = '#e9effb', DEV = '#f59e0b';

/**
 * The icon at `size` px, drawn on 256 units: a cloud on a rounded square of the app's sky. « Cirrus Dev »'s cloud is
 * smaller and higher, over an orange band that says « DEV » from 32 px (a band alone below: no letter reads at 16 px).
 */
function svg(size, dev) {
  // Three lobes on a flat base, centred on (128, 128): x from 47 to 209, y from 72 to 184.
  const cloud = `<g fill="${INK}"${dev ? ' transform="translate(128 102) scale(0.8) translate(-128 -128)"' : ''}>
    <circle cx="83" cy="148" r="36"/><circle cx="131" cy="124" r="52"/><circle cx="175" cy="150" r="34"/>
    <rect x="83" y="140" width="92" height="44"/></g>`;
  const band = !dev ? '' : `<g clip-path="url(#tile)"><rect x="0" y="176" width="256" height="80" fill="${DEV}"/>${size >= 32
    ? `<text x="128" y="235" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="62" letter-spacing="4" fill="${SKY}">DEV</text>`
    : ''}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SKY_TOP}"/><stop offset="1" stop-color="${SKY}"/></linearGradient>
      <clipPath id="tile"><rect x="8" y="8" width="240" height="240" rx="52"/></clipPath>
    </defs>
    <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#sky)"/>
    ${cloud}${band}
  </svg>`;
}

/** A 32-bit bitmap of an ICO (BITMAPINFOHEADER, rows bottom-up, BGRA, then the 1-bit mask of the transparent pixels). */
function bitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8); // the colours and the mask, one over the other
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4), mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/** An ICO file of `images` ({ size, data }: a bitmap, or a PNG at 256 px, whose size the directory writes 0). */
function ico(images) {
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((im) => im.data)]);
}

const { app, BrowserWindow, nativeImage } = await import('electron');
// Not awaited at the top level: an ES module entry that waits for "ready" keeps Electron from ever emitting it.
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');
  /** The PNG (base64) and the pixels (RGBA) of each drawing, rasterised by Chromium at its size. */
  const draw = (items) => win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const { size, svg } of ${JSON.stringify(items)}) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      out.push({ size, png: c.toDataURL('image/png').split(',')[1], rgba: size <= 48 ? Array.from(ctx.getImageData(0, 0, size, size).data) : null });
    }
    return out;
  })()`);
  let failed = false;
  try {
    mkdirSync(join(appDir, 'build'), { recursive: true });
    for (const [name, dev] of [['icon.ico', false], ['icon-dev.ico', true]]) {
      const drawn = await draw(SIZES.map((size) => ({ size, svg: svg(size, dev) })));
      const images = drawn.map(({ size, png, rgba }) => ({ size, data: size >= 256 ? Buffer.from(png, 'base64') : bitmap(size, rgba) }));
      const file = join(appDir, 'build', name);
      writeFileSync(file, ico(images));
      // Read back by Windows' decoder: the file is a valid icon.
      const back = nativeImage.createFromPath(file);
      if (back.isEmpty()) throw new Error(`${name} : illisible une fois écrite.`);
      console.log(`${file} : ${SIZES.join(', ')} px, ${ico(images).length} octets`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    failed = true;
  }
  win.destroy();
  app.exit(failed ? 1 : 0);
});
