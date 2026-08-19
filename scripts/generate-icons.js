/**
 * 生成应用图标
 * - 把 SVG 转成各种尺寸的 PNG
 * - 移动端：1024x1024
 * - macOS .icns（PNG 集合 + 平台工具）
 * - Windows .ico（多尺寸打包）
 */
const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const BUILD_DIR = path.resolve(__dirname, '..', 'build');
const SVG_PATH = path.join(BUILD_DIR, 'icon.svg');

// macOS .icns 需要的尺寸
const MACOS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const WINDOWS_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function generatePngs() {
  console.log('🎨 生成 PNG 图标...');
  const svgBuffer = fs.readFileSync(SVG_PATH);

  // 移动端 + 应用商店：1024x1024
  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(BUILD_DIR, 'icon-1024.png'));
  console.log('  ✅ icon-1024.png');

  // macOS 各尺寸
  for (const size of MACOS_SIZES) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(BUILD_DIR, `icon-${size}.png`));
  }
  console.log(`  ✅ macOS PNG 系列 (${MACOS_SIZES.join(', ')})`);

  // electron-builder 默认查找 icon.png（512x512）
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.png'));
  console.log('  ✅ icon.png (512x512)');

  // 复制一份作为 build/icon.icns 候选（macOS 也接受 PNG 作为图标源）
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(BUILD_DIR, 'icon.icns.png'));
  console.log('  ✅ icon.icns.png');
}

async function generateIco() {
  console.log('🪟 生成 Windows .ico（多尺寸 PNG-in-ICO）...');
  const svgBuffer = fs.readFileSync(SVG_PATH);

  const pngBuffers = [];
  for (const size of WINDOWS_ICO_SIZES) {
    const buf = await sharp(svgBuffer).resize(size, size).png().toBuffer();
    pngBuffers.push(buf);
  }

  // ICO 头部
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                              // reserved
  header.writeUInt16LE(1, 2);                              // type = ICO
  header.writeUInt16LE(WINDOWS_ICO_SIZES.length, 4);       // image count

  const dirSize = 16 * WINDOWS_ICO_SIZES.length;
  let dataOffset = 6 + dirSize;
  const directory = Buffer.alloc(dirSize);
  let dirPos = 0;
  for (let i = 0; i < WINDOWS_ICO_SIZES.length; i++) {
    const size = WINDOWS_ICO_SIZES[i];
    const buf = pngBuffers[i];
    directory.writeUInt8(size === 256 ? 0 : size, dirPos + 0);
    directory.writeUInt8(size === 256 ? 0 : size, dirPos + 1);
    directory.writeUInt8(0, dirPos + 2);
    directory.writeUInt8(0, dirPos + 3);
    directory.writeUInt16LE(1, dirPos + 4);
    directory.writeUInt16LE(32, dirPos + 6);
    directory.writeUInt32LE(buf.length, dirPos + 8);
    directory.writeUInt32LE(dataOffset, dirPos + 12);
    dataOffset += buf.length;
    dirPos += 16;
  }

  const ico = Buffer.concat([header, directory, ...pngBuffers]);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
  console.log(`  ✅ icon.ico (${ico.length} bytes, ${WINDOWS_ICO_SIZES.length} 个尺寸)`);
}

async function generateIcns() {
  console.log('🍎 生成 macOS .icns...');

  // Windows 下无法直接生成 .icns（需要 macOS iconutil）
  // electron-builder 接受 .png 作为图标源，会自动转换
  // 所以这里只生成所需的 PNG 集合

  const svgBuffer = fs.readFileSync(SVG_PATH);
  const iconsetDir = path.join(BUILD_DIR, 'icon.iconset');

  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  // macOS iconset 标准尺寸
  const icnsMap = {
    'icon_16x16.png': 16,
    'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32,
    'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128,
    'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256,
    'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512,
    'icon_512x512@2x.png': 1024,
  };

  for (const [filename, size] of Object.entries(icnsMap)) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(iconsetDir, filename));
  }
  console.log(`  ✅ icon.iconset/ (${Object.keys(icnsMap).length} 个 PNG)`);

  // 尝试在 macOS 上调用 iconutil 合成 .icns
  if (process.platform === 'darwin') {
    try {
      execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(BUILD_DIR, 'icon.icns')}"`, {
        stdio: 'inherit',
      });
      console.log('  ✅ icon.icns (macOS iconutil)');
    } catch (err) {
      console.error('  ❌ iconutil 失败:', err.message);
    }
  } else {
    console.log('  ⚠️  非 macOS，跳过 .icns 合成（electron-builder 自动使用 PNG）');
  }
}

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`❌ SVG 源文件不存在: ${SVG_PATH}`);
    process.exit(1);
  }

  await generatePngs();
  await generateIco();
  await generateIcns();

  console.log('\n🎉 所有图标已生成，路径：build/');
  console.log('💡 提示：');
  console.log('  - macOS 打包：build 中需要 icon.icns 或 icon.png');
  console.log('  - Windows 打包：build 中需要 icon.ico');
  console.log('  - 如果要为 macOS 生成 .icns，请在 macOS 上运行此脚本');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
