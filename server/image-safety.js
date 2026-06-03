const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_INPUT_PIXELS = 40 * 1000 * 1000;
const MAX_IMAGE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_CONTEXT_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 1;
const IMAGE_OUTPUT_SIZE = 1024;

function isLikelyImageMime(mimeType = '') {
    return String(mimeType).toLowerCase().startsWith('image/');
}

function isImagePath(filePath = '') {
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(filePath).toLowerCase());
}

async function normalizeUploadedImage(inputPath, outputPath) {
    const stats = await fs.promises.stat(inputPath);
    if (stats.size > MAX_IMAGE_UPLOAD_BYTES) {
        const err = new Error(`Image file is too large. Maximum is ${Math.round(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)}MB.`);
        err.status = 413;
        throw err;
    }

    const image = sharp(inputPath, {
        limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
        animated: false,
        failOn: 'warning'
    });
    const metadata = await image.metadata();
    const pixels = Number(metadata.width || 0) * Number(metadata.height || 0);
    if (!metadata.width || !metadata.height || pixels > MAX_IMAGE_INPUT_PIXELS) {
        const err = new Error('Image dimensions are too large.');
        err.status = 413;
        throw err;
    }

    let quality = 82;
    let outputInfo = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        outputInfo = await sharp(inputPath, {
            limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
            animated: false,
            failOn: 'warning'
        })
            .rotate()
            .resize({
                width: IMAGE_OUTPUT_SIZE,
                height: IMAGE_OUTPUT_SIZE,
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality, mozjpeg: true })
            .toFile(outputPath);

        if (outputInfo.size <= MAX_IMAGE_OUTPUT_BYTES) break;
        quality -= 14;
    }

    if (outputInfo && outputInfo.size > MAX_IMAGE_OUTPUT_BYTES) {
        const err = new Error(`Compressed image is too large. Maximum is ${Math.round(MAX_IMAGE_OUTPUT_BYTES / 1024 / 1024)}MB.`);
        err.status = 413;
        throw err;
    }

    return outputInfo;
}

async function imageFileToDataUrl(filePath) {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > MAX_IMAGE_CONTEXT_BYTES) return null;

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
    }[ext];
    if (!mime) return null;

    const data = await fs.promises.readFile(filePath);
    return `data:${mime};base64,${data.toString('base64')}`;
}

module.exports = {
    IMAGE_OUTPUT_SIZE,
    MAX_IMAGE_CONTEXT_BYTES,
    MAX_IMAGE_INPUT_PIXELS,
    MAX_IMAGE_OUTPUT_BYTES,
    MAX_IMAGE_UPLOAD_BYTES,
    MAX_IMAGES_PER_MESSAGE,
    imageFileToDataUrl,
    isImagePath,
    isLikelyImageMime,
    normalizeUploadedImage
};
