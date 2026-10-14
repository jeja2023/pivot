const fs = require('fs');
const sharp = require('sharp');

const { renderPdfPages } = require('../../document-text');
const { buildManagedPath, pagesRoot, toProjectRelativePath } = require('./paths');
const { readImageMetadata } = require('./files');

async function writePageBuffer({ userId, jobId, pageNumber, buffer }) {
    const fileName = `${jobId}-page-${String(pageNumber).padStart(4, '0')}.png`;
    const targetPath = await buildManagedPath(pagesRoot, userId, fileName);
    await fs.promises.writeFile(targetPath, buffer);
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
        height,
        pixelWidth: width,
        pixelHeight: height
    };
}

async function renderPdfPagesToFiles({ filePath, userId, jobId, options = {} }) {
    const requestedPages = Array.isArray(options.pageNumbers)
        ? Array.from(new Set(options.pageNumbers.map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))).sort((a, b) => a - b)
        : [];
    const ranges = [];
    requestedPages.forEach(pageNumber => {
        const previous = ranges.at(-1);
        if (previous && pageNumber === previous.last + 1) previous.last = pageNumber;
        else ranges.push({ first: pageNumber, last: pageNumber });
    });
    const sourceRanges = ranges.length ? ranges : [{ first: options.first || 1, last: options.last || null }];
    const pages = [];
    for (const range of sourceRanges) {
        const rendered = await renderPdfPages(filePath, {
            password: options.password,
            first: range.first,
            last: range.last || undefined,
            maxPages: range.last ? range.last - range.first + 1 : options.maxPages,
            desiredWidth: options.desiredWidth || 1400
        });
        pages.push(...rendered);
    }
    const deduplicated = Array.from(new Map(pages.map(page => [Number(page.page), page])).values()).sort((left, right) => Number(left.page) - Number(right.page));
    const written = [];
    for (const page of deduplicated) {
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
