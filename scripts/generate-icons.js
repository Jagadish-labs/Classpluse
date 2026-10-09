const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(size) {
  const width = size;
  const height = size;

  // Raw RGBA scanlines: 1 filter byte per row + width * 4 bytes
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const radius = size * 0.22;
  const pad = size * 0.08;
  const boxX1 = pad;
  const boxY1 = pad;
  const boxX2 = size - pad;
  const boxY2 = size - pad;

  // Helper: check if point (x, y) is inside rounded rectangle
  function isInRoundedBox(x, y) {
    if (x < boxX1 || x > boxX2 || y < boxY1 || y > boxY2) return false;
    let cx = 0, cy = 0;
    if (x < boxX1 + radius) cx = boxX1 + radius;
    else if (x > boxX2 - radius) cx = boxX2 - radius;
    else return true;

    if (y < boxY1 + radius) cy = boxY1 + radius;
    else if (y > boxY2 - radius) cy = boxY2 - radius;
    else return true;

    const dx = x - cx;
    const dy = y - cy;
    return (dx * dx + dy * dy) <= (radius * radius);
  }

  // Draw pulse line points (scaled 0..1 to canvas)
  // [0.22, 0.5] -> [0.36, 0.5] -> [0.42, 0.65] -> [0.50, 0.28] -> [0.58, 0.72] -> [0.64, 0.5] -> [0.78, 0.5]
  const pulsePoints = [
    [0.22 * size, 0.50 * size],
    [0.36 * size, 0.50 * size],
    [0.42 * size, 0.62 * size],
    [0.50 * size, 0.30 * size],
    [0.58 * size, 0.70 * size],
    [0.64 * size, 0.50 * size],
    [0.78 * size, 0.50 * size]
  ];

  // Helper: distance from point (x, y) to line segment (x1, y1)-(x2, y2)
  function distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
  }

  const lineWidth = size * 0.045;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;

      if (!isInRoundedBox(x, y)) {
        // Transparent
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
        continue;
      }

      // Check distance to pulse line
      let minPulseDist = Infinity;
      for (let i = 0; i < pulsePoints.length - 1; i++) {
        const d = distToSegment(x, y, pulsePoints[i][0], pulsePoints[i][1], pulsePoints[i + 1][0], pulsePoints[i + 1][1]);
        if (d < minPulseDist) minPulseDist = d;
      }

      // Check distance to a central circle dot (at peak or center)
      const dotDist = Math.hypot(x - 0.50 * size, y - 0.30 * size);
      const isPeakDot = dotDist < size * 0.035;

      if (minPulseDist < lineWidth || isPeakDot) {
        // White pulse line (#FFFFFF)
        rawData[pixelOffset] = 255;
        rawData[pixelOffset + 1] = 255;
        rawData[pixelOffset + 2] = 255;
        rawData[pixelOffset + 3] = 255;
      } else {
        // Indigo background (#4f46e5 -> R: 79, G: 70, B: 229)
        // Add subtle vertical gradient
        const grad = 1 - (y / height) * 0.15;
        rawData[pixelOffset] = Math.round(79 * grad);
        rawData[pixelOffset + 1] = Math.round(70 * grad);
        rawData[pixelOffset + 2] = Math.min(255, Math.round(229 * grad));
        rawData[pixelOffset + 3] = 255;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = zlib.crc32(typeAndData);
    buf.writeUInt32BE(crc >>> 0, 8 + len);
    return buf;
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate 192x192 PNG
const png192 = createPng(192);
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), png192);
console.log('✅ Generated public/icons/icon-192.png (', png192.length, 'bytes)');

// Generate 512x512 PNG
const png512 = createPng(512);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), png512);
console.log('✅ Generated public/icons/icon-512.png (', png512.length, 'bytes)');

// Generate SVG icon
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4f46e5" />
      <stop offset="100%" stop-color="#3730a3" />
    </linearGradient>
  </defs>
  <rect x="36" y="36" width="440" height="440" rx="96" fill="url(#bgGrad)" />
  <path d="M110 256 L180 256 L212 320 L256 150 L300 360 L332 256 L402 256"
        fill="none"
        stroke="#ffffff"
        stroke-width="26"
        stroke-linecap="round"
        stroke-linejoin="round" />
  <circle cx="256" cy="150" r="16" fill="#ffffff" />
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent, 'utf-8');
console.log('✅ Generated public/icons/icon.svg');
