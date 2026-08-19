const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const iconPath = path.join(root, "resources", "icon.png");
const outDir = path.join(root, "resources");

const sidebarWidth = 164;
const sidebarHeight = 314;
const headerWidth = 150;
const headerHeight = 57;
const dark = "#111113";
const light = "#ffffff";

function encodeBmp24(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 14 + 40 + pixelSize;
  const buf = Buffer.alloc(fileSize);

  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    const destRow = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * 3;
      const di = destRow + x * 3;
      buf[di] = rgb[si + 2];
      buf[di + 1] = rgb[si + 1];
      buf[di + 2] = rgb[si];
    }
  }

  return buf;
}

async function writeBmp(fileName, width, height, rgb) {
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, encodeBmp24(width, height, rgb));
  return filePath;
}

async function makeSidebar() {
  const icon = await sharp(iconPath).resize(84, 84).png().toBuffer();
  const backdrop = Buffer.from(`
    <svg width="${sidebarWidth}" height="${sidebarHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="rail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#5ac8fa"/>
          <stop offset="100%" stop-color="#bf5af2"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="30%" r="48%">
          <stop offset="0%" stop-color="#7c6cff" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${dark}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${sidebarWidth}" height="${sidebarHeight}" fill="${dark}"/>
      <rect width="${sidebarWidth}" height="${sidebarHeight}" fill="url(#glow)"/>
      <rect width="3" height="${sidebarHeight}" fill="url(#rail)"/>
      <text x="82" y="198" text-anchor="middle" font-family="Segoe UI" font-size="14" font-weight="600" fill="#f5f5f7">Quota</text>
      <text x="82" y="218" text-anchor="middle" font-family="Segoe UI" font-size="11" fill="#86868b">Switcher</text>
    </svg>
  `);

  const rgb = await sharp(backdrop)
    .composite([{ input: icon, top: 78, left: 40 }])
    .removeAlpha()
    .raw()
    .toBuffer();

  return writeBmp("installerSidebar.bmp", sidebarWidth, sidebarHeight, rgb);
}

async function makeHeader() {
  const icon = await sharp(iconPath).resize(36, 36).png().toBuffer();
  const backdrop = Buffer.from(`
    <svg width="${headerWidth}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${headerWidth}" height="${headerHeight}" fill="${light}"/>
    </svg>
  `);

  const rgb = await sharp(backdrop)
    .composite([{ input: icon, top: 10, left: 104 }])
    .removeAlpha()
    .raw()
    .toBuffer();

  return writeBmp("installerHeader.bmp", headerWidth, headerHeight, rgb);
}

async function main() {
  if (!fs.existsSync(iconPath)) {
    console.error(`Missing icon: ${iconPath}`);
    process.exit(1);
  }

  const sidebar = await makeSidebar();
  const header = await makeHeader();
  console.log(`Wrote ${path.relative(root, sidebar)}`);
  console.log(`Wrote ${path.relative(root, header)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
