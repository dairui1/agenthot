import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const svg = readFileSync(new URL("../site/brand/logo.svg", import.meta.url));
for (const [name, size] of [["icon.png", 512], ["icon-192.png", 192], ["apple-icon.png", 180]] as const) {
  await sharp(svg).resize(size, size).png().toFile(new URL(`../site/brand/${name}`, import.meta.url).pathname);
}
const png = await sharp(svg).resize(32, 32).png().toBuffer();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = ico[7] = 32;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
writeFileSync(new URL("../site/brand/favicon.ico", import.meta.url), Buffer.concat([ico, png]));
