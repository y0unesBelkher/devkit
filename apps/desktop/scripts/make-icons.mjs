// Renders DevKit's icons from SVG: build/icon.ico + build/icon.png (installer, window, shortcut) and
// assets/tray-*.png (system tray, normal and "daemon offline"). Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

/** The app icon: a rounded square with three stacked "service" layers and a status light. */
function appSvg({ from, to, light }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#shine)"/>
  <rect x="96" y="300" width="320" height="64" rx="32" fill="#fff" fill-opacity=".55"/>
  <rect x="96" y="222" width="320" height="64" rx="32" fill="#fff" fill-opacity=".78"/>
  <rect x="96" y="144" width="320" height="64" rx="32" fill="#fff"/>
  <path d="M136 160 l26 16 l-26 16" fill="none" stroke="${to}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="176" y="186" width="44" height="12" rx="6" fill="${to}"/>
  <circle cx="380" cy="176" r="15" fill="${light}"/>
</svg>`;
}

/** Tray icons are drawn tiny: only the square and the three layers, so they stay crisp at 16 px. */
function traySvg({ from, to }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#bg)"/>
  <rect x="7" y="19.5" width="18" height="4" rx="2" fill="#fff" fill-opacity=".6"/>
  <rect x="7" y="14" width="18" height="4" rx="2" fill="#fff" fill-opacity=".82"/>
  <rect x="7" y="8.5" width="18" height="4" rx="2" fill="#fff"/>
</svg>`;
}

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** ICO with PNG-compressed images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const ok = { from: '#34d399', to: '#047857', light: '#34d399' };
const warn = { from: '#fbbf24', to: '#b45309' };

mkdirSync('build', { recursive: true });
mkdirSync('assets', { recursive: true });
const app = appSvg(ok);
writeFileSync('build/icon.png', render(app, 512));
writeFileSync('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: render(app, size) }))));
writeFileSync('assets/icon.png', render(app, 256));
for (const [name, colors] of [['tray', ok], ['tray-offline', warn]]) {
  writeFileSync(`assets/${name}.png`, render(traySvg(colors), 16));
  writeFileSync(`assets/${name}@2x.png`, render(traySvg(colors), 32));
}
console.log('icons written to build/ and assets/');
