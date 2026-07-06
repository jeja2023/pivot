const fs = require('fs');
const sharp = require('sharp');

const { renderPdfPages } = require('../../document-text');
const { buildManagedPath, pagesRoot, toProjectRelativePath } = require('./paths');
const { readImageMetadata } = require('./files');

async function writePageBuffer({ userId, jobId, pageNumber, buffer }) {
    const fileName = `${jobId}-page-${String(pageNumber).padStart(4, '0')}.png`;
    const targetPath = buildManagedPath(pagesRoot, userId, fileName);
    fs.writeFileSync(targetPath, buffer);
    let width = 0;
    let height = 0;
    try {
        const metadata = await sharp(targetPath).metadata();
        width = Number(metadata.width || 0);
        height = Number(metadata.height || 0);
    } catch (_err) {
        width = 0;
        height = 0;
    }
    return {
        pageNumber,
        imagePath: toProjectRelativePath(targetPath),
        width,
        height
    };
}

async function renderPdfPagesToFiles({ filePath, userId, jobId, options = {} }) {
    const pages = await renderPdfPages(filePath, {
        password: options.password,
        first: options.first || 1,
        last: options.last,
        maxPages: options.maxPages,
        desiredWidth: options.desiredWidth || 1400
    });
    const written = [];
    for (const page of pages) {
        written.push(await writePageBuffer({
            userId,
            jobId,
            pageNumber: Number(page.page || written.length + 1),
            buffer: page.data
        }));
    }
    return written;
}

async function imageFileToPage({ filePath, relativePath, pageNumber = 1 }) {
    const metadata = await readImageMetadata(filePath);
    return {
        pageNumber,
        imagePath: relativePath,
        width: metadata.width,
        height: metadata.height
    };
}

module.exports = {
    imageFileToPage,
    renderPdfPagesToFiles,
    writePageBuffer
};
