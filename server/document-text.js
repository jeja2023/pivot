const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pdfParse = require('pdf-parse');
const WordExtractor = require('word-extractor');
const XLSX = require('xlsx');

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.java', '.cpp',
    '.c', '.h', '.html', '.css', '.yaml', '.yml', '.sql', '.log'
]);

const CFB_FREE = 0xffffffff;
const CFB_END = 0xfffffffe;
const CFB_FAT = 0xfffffffd;
const CFB_DIFAT = 0xfffffffc;

function isOleFile(buffer) {
    return buffer.length >= 8
        && buffer[0] === 0xd0
        && buffer[1] === 0xcf
        && buffer[2] === 0x11
        && buffer[3] === 0xe0
        && buffer[4] === 0xa1
        && buffer[5] === 0xb1
        && buffer[6] === 0x1a
        && buffer[7] === 0xe1;
}

function normalizeExtractedPlainText(text) {
    return String(text || '')
        .replace(/\u0000/g, '')
        .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function decodeXmlEntities(value) {
    return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlToText(xml) {
    return decodeXmlEntities(String(xml || '')
        .replace(/<w:tab\s*\/>/g, '\t')
        .replace(/<w:br\s*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<\/w:tr>/g, '\n')
        .replace(/<\/w:tc>/g, '\t')
        .replace(/<[^>]+>/g, ''))
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function findEndOfCentralDirectory(buffer) {
    const minOffset = Math.max(0, buffer.length - 65557);
    for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    return -1;
}

function readZipEntries(buffer) {
    const eocdOffset = findEndOfCentralDirectory(buffer);
    if (eocdOffset < 0) throw new Error('Invalid ZIP file: central directory not found');

    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    let offset = buffer.readUInt32LE(eocdOffset + 16);
    const entries = new Map();

    for (let i = 0; i < entryCount; i += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Invalid ZIP file: central directory entry is corrupt');
        }

        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const nameStart = offset + 46;
        const encoding = flags & 0x0800 ? 'utf8' : 'latin1';
        const fileName = buffer.toString(encoding, nameStart, nameStart + fileNameLength).replace(/\\/g, '/');

        if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error(`Invalid ZIP file: local header missing for ${fileName}`);
        }

        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

        let data;
        if (method === 0) {
            data = compressedData;
        } else if (method === 8) {
            data = zlib.inflateRawSync(compressedData);
        } else {
            data = Buffer.alloc(0);
        }

        entries.set(fileName, data);
        offset = nameStart + fileNameLength + extraLength + commentLength;
    }

    return entries;
}

function sectorOffset(sectorId, sectorSize) {
    return (sectorId + 1) * sectorSize;
}

function readSectorChain(buffer, fat, startSector, sectorSize, maxBytes = Infinity) {
    if (startSector < 0 || startSector >= fat.length) return Buffer.alloc(0);

    const chunks = [];
    const seen = new Set();
    let sector = startSector;
    let total = 0;

    while (sector !== CFB_END && sector !== CFB_FREE && sector >= 0 && sector < fat.length && !seen.has(sector)) {
        seen.add(sector);
        const offset = sectorOffset(sector, sectorSize);
        if (offset < 0 || offset >= buffer.length) break;

        const remaining = maxBytes - total;
        if (remaining <= 0) break;
        const sliceLength = Math.min(sectorSize, remaining, buffer.length - offset);
        chunks.push(buffer.subarray(offset, offset + sliceLength));
        total += sliceLength;

        const next = fat[sector];
        if (next === CFB_FAT || next === CFB_DIFAT) break;
        sector = next;
    }

    return Buffer.concat(chunks);
}

function parseOleDirectoryName(entry) {
    const nameLength = entry.readUInt16LE(64);
    if (nameLength < 2) return '';
    return entry.subarray(0, Math.min(nameLength - 2, 64)).toString('utf16le');
}

function readOleStreams(buffer) {
    if (!isOleFile(buffer)) throw new Error('Invalid OLE compound document');

    const sectorShift = buffer.readUInt16LE(30);
    const miniSectorShift = buffer.readUInt16LE(32);
    const sectorSize = 1 << sectorShift;
    const miniSectorSize = 1 << miniSectorShift;
    const fatSectorCount = buffer.readUInt32LE(44);
    const firstDirectorySector = buffer.readInt32LE(48);
    const miniStreamCutoff = buffer.readUInt32LE(56);
    const firstMiniFatSector = buffer.readInt32LE(60);
    const miniFatSectorCount = buffer.readUInt32LE(64);
    const firstDifatSector = buffer.readInt32LE(68);
    const difatSectorCount = buffer.readUInt32LE(72);

    const fatSectors = [];
    for (let i = 0; i < 109; i += 1) {
        const sector = buffer.readUInt32LE(76 + i * 4);
        if (sector !== CFB_FREE) fatSectors.push(sector);
    }

    let difatSector = firstDifatSector;
    for (let i = 0; i < difatSectorCount && difatSector !== CFB_END; i += 1) {
        const offset = sectorOffset(difatSector, sectorSize);
        if (offset < 0 || offset + sectorSize > buffer.length) break;
        const entriesPerDifat = (sectorSize / 4) - 1;
        for (let j = 0; j < entriesPerDifat; j += 1) {
            const sector = buffer.readUInt32LE(offset + j * 4);
            if (sector !== CFB_FREE) fatSectors.push(sector);
        }
        difatSector = buffer.readUInt32LE(offset + entriesPerDifat * 4);
    }

    const fat = [];
    for (const sector of fatSectors.slice(0, fatSectorCount || fatSectors.length)) {
        const offset = sectorOffset(sector, sectorSize);
        if (offset < 0 || offset + sectorSize > buffer.length) continue;
        for (let pos = 0; pos < sectorSize; pos += 4) {
            fat.push(buffer.readUInt32LE(offset + pos));
        }
    }

    const directory = readSectorChain(buffer, fat, firstDirectorySector, sectorSize);
    if (directory.length < 128) throw new Error('OLE directory stream is empty');

    const entries = [];
    for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
        const entry = directory.subarray(offset, offset + 128);
        const name = parseOleDirectoryName(entry);
        const type = entry[66];
        const startSector = entry.readInt32LE(116);
        const size = Number(entry.readBigUInt64LE(120));
        entries.push({ name, type, startSector, size });
    }

    const rootEntry = entries.find(entry => entry.type === 5) || entries[0];
    const miniFat = [];
    if (firstMiniFatSector !== CFB_END && firstMiniFatSector >= 0 && miniFatSectorCount > 0) {
        const miniFatBuffer = readSectorChain(buffer, fat, firstMiniFatSector, sectorSize, miniFatSectorCount * sectorSize);
        for (let offset = 0; offset + 4 <= miniFatBuffer.length; offset += 4) {
            miniFat.push(miniFatBuffer.readUInt32LE(offset));
        }
    }

    const miniStream = rootEntry
        ? readSectorChain(buffer, fat, rootEntry.startSector, sectorSize, rootEntry.size)
        : Buffer.alloc(0);
    const streams = new Map();

    for (const entry of entries) {
        if (entry.type !== 2 || !entry.name || entry.size <= 0) continue;
        let data;
        if (entry.size < miniStreamCutoff && miniFat.length > 0) {
            const chunks = [];
            const seen = new Set();
            let sector = entry.startSector;
            let total = 0;
            while (sector !== CFB_END && sector !== CFB_FREE && sector >= 0 && sector < miniFat.length && !seen.has(sector)) {
                seen.add(sector);
                const offset = sector * miniSectorSize;
                const remaining = entry.size - total;
                if (remaining <= 0 || offset >= miniStream.length) break;
                const sliceLength = Math.min(miniSectorSize, remaining, miniStream.length - offset);
                chunks.push(miniStream.subarray(offset, offset + sliceLength));
                total += sliceLength;
                sector = miniFat[sector];
            }
            data = Buffer.concat(chunks).subarray(0, entry.size);
        } else {
            data = readSectorChain(buffer, fat, entry.startSector, sectorSize, entry.size).subarray(0, entry.size);
        }
        streams.set(entry.name, data);
    }

    return streams;
}

function isPasswordError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name.includes('Password') || /password|encrypted|decrypt/i.test(message);
}

async function extractPdfText(filePath, options = {}) {
    const buffer = fs.readFileSync(filePath);

    if (typeof pdfParse === 'function') {
        const data = await pdfParse(buffer, options.password ? { password: options.password } : undefined);
        return data.text || '';
    }

    if (pdfParse && typeof pdfParse.PDFParse === 'function') {
        const parser = new pdfParse.PDFParse({
            data: buffer,
            ...(options.password ? { password: options.password } : {})
        });
        try {
            const result = await parser.getText();
            return result.text || '';
        } finally {
            if (typeof parser.destroy === 'function') await parser.destroy();
        }
    }

    throw new Error('Unsupported pdf-parse export shape');
}

async function renderPdfPages(filePath, options = {}) {
    if (!pdfParse || typeof pdfParse.PDFParse !== 'function') return [];

    const parser = new pdfParse.PDFParse({
        data: fs.readFileSync(filePath),
        ...(options.password ? { password: options.password } : {})
    });
    try {
        const result = await parser.getScreenshot({
            first: options.first || 1,
            last: options.last || Math.min(options.maxPages || 3, 3),
            desiredWidth: options.desiredWidth || 1400,
            imageBuffer: true,
            imageDataUrl: false
        });
        return (result.pages || [])
            .map((page, index) => ({
                page: page.pageNumber || index + 1,
                data: page.data || page.imageBuffer,
                mimeType: 'image/png'
            }))
            .filter(page => page.data);
    } finally {
        if (typeof parser.destroy === 'function') await parser.destroy();
    }
}

function extractDocxText(filePath) {
    const entries = readZipEntries(fs.readFileSync(filePath));
    const xmlNames = Array.from(entries.keys())
        .filter(name => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name))
        .sort((a, b) => {
            if (a === 'word/document.xml') return -1;
            if (b === 'word/document.xml') return 1;
            return a.localeCompare(b);
        });

    return xmlNames
        .map(name => xmlToText(entries.get(name).toString('utf8')))
        .filter(Boolean)
        .join('\n\n');
}

async function extractWordText(filePath, options = {}) {
    if (options.password) {
        const error = new Error('Password-protected Word documents are not supported by the current parser');
        error.code = 'PASSWORD_UNSUPPORTED';
        throw error;
    }
    const extractor = new WordExtractor();
    const doc = await extractor.extract(filePath);
    const parts = [
        doc.getBody?.(),
        doc.getHeaders?.(),
        doc.getFooters?.(),
        doc.getFootnotes?.(),
        doc.getEndnotes?.(),
        doc.getAnnotations?.(),
        doc.getTextboxes?.()
    ].filter(Boolean);

    return normalizeExtractedPlainText(parts.join('\n\n'));
}

function extractSharedStrings(xml) {
    const values = [];
    const itemRegex = /<si[\s\S]*?<\/si>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        values.push(xmlToText(match[0]));
    }
    return values;
}

function extractCellValue(cellXml, sharedStrings) {
    const type = /<c\b[^>]*\bt="([^"]+)"/.exec(cellXml)?.[1];
    if (type === 'inlineStr') return xmlToText(cellXml);

    const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] || '';
    if (!value) return '';
    if (type === 's') return sharedStrings[Number(value)] || '';
    if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
    return decodeXmlEntities(value).trim();
}

function extractXlsxText(filePath) {
    const entries = readZipEntries(fs.readFileSync(filePath));
    const sharedStrings = entries.has('xl/sharedStrings.xml')
        ? extractSharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8'))
        : [];
    const sheetNames = Array.from(entries.keys())
        .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const sheets = [];
    for (const name of sheetNames) {
        const xml = entries.get(name).toString('utf8');
        const rows = [];
        const rowRegex = /<row\b[\s\S]*?<\/row>/g;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(xml)) !== null) {
            const cells = [];
            const cellRegex = /<c\b[\s\S]*?<\/c>/g;
            let cellMatch;
            while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
                cells.push(extractCellValue(cellMatch[0], sharedStrings));
            }
            if (cells.some(Boolean)) rows.push(cells.join('\t').replace(/\t+$/g, ''));
        }
        if (rows.length > 0) sheets.push(`${path.basename(name, '.xml')}:\n${rows.join('\n')}`);
    }

    return sheets.join('\n\n');
}

function extractWorkbookText(filePath, options = {}) {
    const workbook = XLSX.readFile(filePath, {
        cellDates: true,
        dense: false,
        raw: false,
        ...(options.password ? { password: options.password } : {})
    });
    const sheets = [];

    for (const sheetName of workbook.SheetNames || []) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const text = XLSX.utils.sheet_to_csv(sheet, {
            FS: '\t',
            RS: '\n',
            blankrows: false,
            strip: true
        }).trim();
        if (text) sheets.push(`${sheetName}:\n${text}`);
    }

    return normalizeExtractedPlainText(sheets.join('\n\n'));
}

function extractUtf16Runs(buffer, minChars = 3) {
    const results = [];
    let start = -1;
    let chars = [];

    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
        const code = buffer.readUInt16LE(offset);
        const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xfffd);
        if (printable && code !== 0xffff) {
            if (start < 0) start = offset;
            chars.push(String.fromCharCode(code));
        } else {
            if (chars.length >= minChars) results.push(chars.join(''));
            start = -1;
            chars = [];
        }
    }

    if (start >= 0 && chars.length >= minChars) results.push(chars.join(''));
    return results;
}

function extractAsciiRuns(buffer, minChars = 4) {
    const results = [];
    let chars = [];

    for (const byte of buffer) {
        const printable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
        if (printable) {
            chars.push(String.fromCharCode(byte));
        } else {
            if (chars.length >= minChars) results.push(chars.join(''));
            chars = [];
        }
    }

    if (chars.length >= minChars) results.push(chars.join(''));
    return results;
}

function extractDocBinaryText(filePath) {
    const streams = readOleStreams(fs.readFileSync(filePath));
    const wordDocument = streams.get('WordDocument');
    if (!wordDocument) throw new Error('WordDocument stream not found');

    const tableStream = streams.get('1Table') || streams.get('0Table');
    let text = '';

    try {
        if (wordDocument.length > 0x4c) {
            const fibFlags = wordDocument.readUInt16LE(0x0a);
            const tableName = (fibFlags & 0x0200) ? '1Table' : '0Table';
            const selectedTable = streams.get(tableName) || tableStream;
            const fcMin = wordDocument.readUInt32LE(0x18);
            const fcMac = wordDocument.readUInt32LE(0x1c);
            if (fcMac > fcMin && fcMin < wordDocument.length) {
                text = wordDocument.subarray(fcMin, Math.min(fcMac, wordDocument.length)).toString('utf16le');
            }

            if (!normalizeExtractedPlainText(text) && selectedTable) {
                text = extractUtf16Runs(selectedTable).join('\n');
            }
        }
    } catch (err) {
        text = '';
    }

    if (!normalizeExtractedPlainText(text)) {
        const unicodeText = extractUtf16Runs(wordDocument).join('\n');
        const asciiText = extractAsciiRuns(wordDocument).join('\n');
        text = unicodeText.length >= asciiText.length ? unicodeText : asciiText;
    }

    return normalizeExtractedPlainText(text);
}

function parseBiffString(buffer, offset, options = {}) {
    const { hasHighByteFlag = true, lengthBytes = 1 } = options;
    if (offset + lengthBytes > buffer.length) return { value: '', nextOffset: buffer.length };

    const charCount = lengthBytes === 2 ? buffer.readUInt16LE(offset) : buffer[offset];
    let cursor = offset + lengthBytes;
    let isUtf16 = false;
    if (hasHighByteFlag) {
        if (cursor >= buffer.length) return { value: '', nextOffset: cursor };
        const flags = buffer[cursor];
        cursor += 1;
        isUtf16 = Boolean(flags & 0x01);
    }

    const byteLength = charCount * (isUtf16 ? 2 : 1);
    const end = Math.min(cursor + byteLength, buffer.length);
    const value = isUtf16
        ? buffer.subarray(cursor, end).toString('utf16le')
        : buffer.subarray(cursor, end).toString('latin1');
    return { value, nextOffset: end };
}

function decodeXlsNumber(value) {
    if (!Number.isFinite(value)) return '';
    if (Math.abs(value - Math.round(value)) < 1e-10) return String(Math.round(value));
    return String(value);
}

function extractXlsBinaryText(filePath) {
    const streams = readOleStreams(fs.readFileSync(filePath));
    const workbook = streams.get('Workbook') || streams.get('Book');
    if (!workbook) throw new Error('Workbook stream not found');

    const sharedStrings = [];
    const rows = [];

    for (let offset = 0; offset + 4 <= workbook.length;) {
        const id = workbook.readUInt16LE(offset);
        const length = workbook.readUInt16LE(offset + 2);
        const dataStart = offset + 4;
        const dataEnd = Math.min(dataStart + length, workbook.length);
        const record = workbook.subarray(dataStart, dataEnd);

        try {
            if (id === 0x00fc && record.length >= 8) {
                let cursor = 8;
                while (cursor < record.length) {
                    const parsed = parseBiffString(record, cursor, { hasHighByteFlag: true, lengthBytes: 2 });
                    if (parsed.value) sharedStrings.push(normalizeExtractedPlainText(parsed.value));
                    if (parsed.nextOffset <= cursor) break;
                    cursor = parsed.nextOffset;
                }
            } else if (id === 0x00fd && record.length >= 10) {
                const row = record.readUInt16LE(0);
                const col = record.readUInt16LE(2);
                const sstIndex = record.readUInt32LE(6);
                const value = sharedStrings[sstIndex] || '';
                if (value) rows.push({ row, col, value });
            } else if ((id === 0x0204 || id === 0x0004) && record.length >= 8) {
                const row = record.readUInt16LE(0);
                const col = record.readUInt16LE(2);
                const parsed = parseBiffString(record, 6, { hasHighByteFlag: id === 0x0204, lengthBytes: 2 });
                if (parsed.value) rows.push({ row, col, value: normalizeExtractedPlainText(parsed.value) });
            } else if (id === 0x0203 && record.length >= 14) {
                const row = record.readUInt16LE(0);
                const col = record.readUInt16LE(2);
                const value = decodeXlsNumber(record.readDoubleLE(6));
                if (value) rows.push({ row, col, value });
            } else if (id === 0x0201 && record.length >= 8) {
                const row = record.readUInt16LE(0);
                const col = record.readUInt16LE(2);
                const value = String(record.readUInt16LE(6));
                rows.push({ row, col, value });
            }
        } catch (err) {
            // Ignore malformed records and keep extracting the rest of the workbook.
        }

        offset = dataEnd;
    }

    if (rows.length === 0) {
        return normalizeExtractedPlainText([
            ...extractUtf16Runs(workbook),
            ...extractAsciiRuns(workbook)
        ].join('\n'));
    }

    rows.sort((a, b) => a.row - b.row || a.col - b.col);
    const output = [];
    let currentRow = -1;
    let line = [];

    for (const cell of rows) {
        if (cell.row !== currentRow) {
            if (line.length) output.push(line.join('\t').replace(/\t+$/g, ''));
            currentRow = cell.row;
            line = [];
        }
        while (line.length < cell.col) line.push('');
        line[cell.col] = cell.value;
    }
    if (line.length) output.push(line.join('\t').replace(/\t+$/g, ''));

    return normalizeExtractedPlainText(output.join('\n'));
}

async function extractDocumentText(filePath, mimeType = '', originalName = '', options = {}) {
    const ext = path.extname(originalName || filePath || '').toLowerCase();
    const mime = String(mimeType || '').toLowerCase();

    if (ext === '.pdf' || mime === 'application/pdf') return extractPdfText(filePath, options);
    if (ext === '.doc' || ext === '.docx') {
        try {
            return await extractWordText(filePath, options);
        } catch (err) {
            if (isPasswordError(err) || err.code === 'PASSWORD_UNSUPPORTED') throw err;
            if (ext === '.doc') return extractDocBinaryText(filePath);
            return extractDocxText(filePath);
        }
    }
    if (ext === '.xls' || ext === '.xlsx') {
        try {
            return extractWorkbookText(filePath, options);
        } catch (err) {
            if (isPasswordError(err) && !options.password) throw err;
            if (ext === '.xls') return extractXlsBinaryText(filePath);
            return extractXlsxText(filePath);
        }
    }
    if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/')) return fs.readFileSync(filePath, 'utf8');
    return '';
}

function truncateExtractedText(text, maxLength = 200000) {
    if (!text || text.length <= maxLength) return text || '';
    return `${text.slice(0, maxLength)}\n\n[Document content is too long and was truncated to the first ${maxLength} characters]`;
}

module.exports = {
    isPasswordError,
    renderPdfPages,
    extractDocumentText,
    truncateExtractedText
};
