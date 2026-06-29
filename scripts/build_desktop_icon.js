const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const sourceCandidates = [
    path.join(root, 'client', 'logo图标.png'),
    path.join(root, 'client', 'favicon.png'),
    path.join(root, 'client', 'common', 'logo.png')
];
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const desktopIconSizes = [16, 24, 32, 48, 64, 128, 256];
const faviconSizes = [16, 32, 48];
const pngOutputs = [
    { relPath: 'client/favicon-16x16.png', size: 16, crop: true, paddingRatio: 0 },
    { relPath: 'client/favicon-32x32.png', size: 32, crop: true, paddingRatio: 0 },
    { relPath: 'client/apple-touch-icon.png', size: 180, crop: true, paddingRatio: 0.08 },
    { relPath: 'client/android-chrome-192x192.png', size: 192, crop: true, paddingRatio: 0.08 },
    { relPath: 'client/android-chrome-512x512.png', size: 512, crop: true, paddingRatio: 0.08 },
    { relPath: 'client/maskable-icon-192x192.png', size: 192, crop: true, paddingRatio: 0.22 },
    { relPath: 'client/maskable-icon-512x512.png', size: 512, crop: true, paddingRatio: 0.22 },
    { relPath: 'client/favicon.png', size: 512, crop: true, paddingRatio: 0 },
    { relPath: 'client/common/logo.png', size: 512, crop: true, paddingRatio: 0 }
];
const icoOutputs = [
    { relPath: 'client/favicon.ico', sizes: faviconSizes, crop: true, paddingRatio: 0 },
    { relPath: 'desktop/icon.ico', sizes: desktopIconSizes, crop: true }
];

function encodeIcoEntry(size, imageSize, imageOffset) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(imageSize, 8);
    entry.writeUInt32LE(imageOffset, 12);
    return entry;
}

function isBackgroundPixel(red, green, blue, alpha) {
    if (alpha < 8) return true;
    const isWhiteBackground = red > 238 && green > 238 && blue > 238;
    const isNearWhiteNeutral = Math.abs(red - green) < 4 && Math.abs(red - blue) < 4 && red > 225;
    return isWhiteBackground || isNearWhiteNeutral;
}

async function makeTransparentSource(sourceBuffer) {
    const { data, info } = await sharp(sourceBuffer)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    for (let i = 0; i < data.length; i += 4) {
        const red = data[i];
        const green = data[i + 1];
        const blue = data[i + 2];
        const alpha = data[i + 3];
        if (isBackgroundPixel(red, green, blue, alpha)) {
            data[i + 3] = 0;
        }
    }

    return sharp(data, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4
        }
    })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function findContentTrim(sourceBuffer) {
    const { data, info } = await sharp(sourceBuffer)
        .rotate()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
            const alpha = data[(y * info.width + x) * 4 + 3];
            if (alpha >= 8) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    }

    if (maxX < minX || maxY < minY) return null;
    return {
        left: minX,
        top: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
    };
}

async function renderPng(sourceBuffer, size, options = {}) {
    const input = options.crop && options.trim
        ? await sharp(sourceBuffer).rotate().extract(options.trim).png().toBuffer()
        : sourceBuffer;
    const paddingRatio = Number.isFinite(options.paddingRatio)
        ? options.paddingRatio
        : (options.crop ? 0.04 : 0);
    const resizeSize = Math.max(1, Math.round(size * (1 - paddingRatio)));
    const resized = await sharp(input)
        .rotate()
        .resize(resizeSize, resizeSize, {
            fit: 'contain',
            background: transparent
        })
        .ensureAlpha()
        .png({ compressionLevel: 9 })
        .toBuffer();

    if (!options.crop && paddingRatio === 0) return resized;

    return sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: transparent
        }
    })
        .composite([{ input: resized, gravity: 'center' }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function writePng(sourceBuffer, output) {
    const outputPath = path.join(root, output.relPath);
    const buffer = await renderPng(sourceBuffer, output.size, {
        crop: output.crop,
        paddingRatio: output.paddingRatio,
        trim: output.trim
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    return output.relPath;
}

async function writeIco(sourceBuffer, output) {
    const images = [];
    for (const size of output.sizes) {
        const buffer = await renderPng(sourceBuffer, size, {
            crop: output.crop,
            paddingRatio: output.paddingRatio,
            trim: output.trim
        });
        images.push({ size, buffer });
    }

    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    let offset = header.length + images.length * 16;
    const entries = images.map(({ size, buffer }) => {
        const entry = encodeIcoEntry(size, buffer.length, offset);
        offset += buffer.length;
        return entry;
    });

    const outputPath = path.join(root, output.relPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.concat([header, ...entries, ...images.map(item => item.buffer)]));
    return output.relPath;
}

async function main() {
    const sourcePath = sourceCandidates.find(candidate => fs.existsSync(candidate));
    if (!sourcePath) {
        throw new Error('No PNG source found for icon generation.');
    }
    const sourceBuffer = fs.readFileSync(sourcePath);
    const transparentSource = await makeTransparentSource(sourceBuffer);
    const contentTrim = await findContentTrim(transparentSource);
    pngOutputs.filter(output => output.crop).forEach(output => { output.trim = contentTrim; });
    icoOutputs.filter(output => output.crop).forEach(output => { output.trim = contentTrim; });

    const written = [];
    for (const output of pngOutputs) written.push(await writePng(transparentSource, output));
    for (const output of icoOutputs) written.push(await writeIco(transparentSource, output));

    console.log('Icon source: ' + path.relative(root, sourcePath));
    if (contentTrim) console.log('Icon crop: ' + contentTrim.left + ',' + contentTrim.top + ' ' + contentTrim.width + 'x' + contentTrim.height);
    written.forEach(file => console.log('Icon written: ' + file));
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
