import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('../vendor/qrcode/index.js');
const level = require('../vendor/qrcode/QRErrorCorrectLevel.js');

export function qrSvgDataUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  const qr = new QRCode(-1, level.M);
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const border = 4;
  const size = count + border * 2;
  let paths = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) paths += `M${col + border} ${row + border}h1v1h-1z`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#111827" d="${paths}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
