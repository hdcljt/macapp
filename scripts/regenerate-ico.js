/**
 * 重新生成真正的 ICO 图标（多尺寸打包）
 * sharp 不输出真 ICO，手动写 ICO 容器（PNG-in-ICO 格式）
 */
const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs');

const BUILD_DIR = path.resolve(__dirname, '..', 'build');
const SVG_PATH = path.join(BUILD_DIR, 'icon.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`❌ SVG 不存在: ${SVG_PATH}`);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(SVG_PATH);
  const pngBuffers = [];

  for (const size of SIZES) {
    const buf = await sharp(svgBuffer).resize(size, size).png().toBuffer();
    pngBuffers.push(buf);
    console.log(`  ✅ ${size}x${size}.png  (${buf.length} bytes)`);
  }

  // ICO 文件头 (6 bytes)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type = 1 (ICO)
  header.writeUInt16LE(SIZES.length, 4); // image count

  // 计算每个条目大小 = 16 字节
  const dirSize = 16 * SIZES.length;
  let dataOffset = 6 + dirSize;

  const directory = Buffer.alloc(dirSize);
  let dirPos = 0;
  for (let i = 0; i < SIZES.length; i++) {
    const size = SIZES[i];
    const buf = pngBuffers[i];
    directory.writeUInt8(size === 256 ? 0 : size, dirPos + 0); // width
    directory.writeUInt8(size === 256 ? 0 : size, dirPos + 1); // height
    directory.writeUInt8(0, dirPos + 2);                       // colors (0 = no palette)
    directory.writeUInt8(0, dirPos + 3);                       // reserved
    directory.writeUInt16LE(1, dirPos + 4);                    // planes
    directory.writeUInt16LE(32, dirPos + 6);                   // bit depth
    directory.writeUInt32LE(buf.length, dirPos + 8);           // data size
    directory.writeUInt32LE(dataOffset, dirPos + 12);         // data offset
    dataOffset += buf.length;
    dirPos += 16;
  }

  const ico = Buffer.concat([header, directory, ...pngBuffers]);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
  console.log(`\n🎉 写入: build/icon.ico (${ico.length} bytes, ${SIZES.length} 个尺寸)`);

  // 验证 magic number
  const magic = ico.readUInt16LE(0);
  const type = ico.readUInt16LE(2);
  const count = ico.readUInt16LE(4);
  console.log(`🔍 Magic: 0x${magic.toString(16)}  Type: ${type} (1=ICO)  Count: ${count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});