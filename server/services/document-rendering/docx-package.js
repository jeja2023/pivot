/**
 * server/services/document-rendering/docx-package.js
 * 确定性 ZIP 重打包（OOXML 包幂等化）
 *
 * 落地方案 v1.2 §10.2 最后一段：渲染确定性是「渲染幂等性 100%」与
 * UNIQUE (ir_digest, format, renderer_version) 去重键成立的前提。
 *
 * docx 库产出的 OOXML 包有两处非确定字段：
 * 1. docProps/core.xml 的 dcterms:created / dcterms:modified 写的是渲染时的墙上时钟；
 * 2. 底层 jszip 会把每个条目的 DOS 时间戳写成打包时刻，且压缩流不保证跨环境逐字节一致。
 * 因此这里把包整体解开后重新打包：条目内容不变，时间戳固定，条目顺序固定，压缩方式固定为 STORE。
 * 只删除目录条目（OOXML 读取端不依赖目录条目），文件条目一个不少。
 *
 * 实现思路参照 server/services/document-processing/exporters/index.js 的 createZip，
 * 但该文件的 dosDateTime 取当前时间，无法满足幂等要求，故此处独立实现且不修改原文件。
 */
const unzipper = require('unzipper');

/** docProps/core.xml 的包内路径。 */
const CORE_PROPERTIES_PATH = 'docProps/core.xml';

/** 固定的 DOS 时间戳：1980-01-01 00:00:00，是 ZIP 能表达的最早时间。 */
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME = 0;

/** 派生时间戳的基准时刻：2000-01-01T00:00:00Z。 */
const DERIVED_TIMESTAMP_BASE_MS = Date.UTC(2000, 0, 1);

/** ZIP 单条目与整包的 32 位长度上限；超限需要 ZIP64，这里显式拒绝而不是写出损坏的包。 */
const ZIP_MAX_SIZE = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;

/** OOXML 读取端习惯先看到内容类型清单与根关系，这两个条目固定排在最前。 */
const ENTRY_ORDER_HEAD = Object.freeze(['[Content_Types].xml', '_rels/.rels']);

let crcTable = null;

function getCrcTable() {
    if (crcTable) return crcTable;
    const table = new Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[i] = value >>> 0;
    }
    crcTable = table;
    return crcTable;
}

/** 计算 CRC-32（ZIP 条目校验值）。 */
function crc32(buffer) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function packageError(message, code = 'DOCX_PACKAGE_INVALID') {
    const error = new Error(message);
    error.code = code;
    error.status = 500;
    error.statusCode = 500;
    return error;
}

/**
 * 由 IR 摘要派生确定的文档时间戳。
 * 取摘要前 8 位十六进制换算成 2000-01-01 当天内的秒偏移：同一 IR 恒得同一时刻，
 * 不同 IR 得到不同时刻，且年份固定为 2000，一眼可辨是渲染器写入的合成值而非真实创建时间。
 */
function deriveDeterministicTimestamp(irDigest) {
    const head = String(irDigest || '').slice(0, 8).toLowerCase();
    const offsetSeconds = /^[0-9a-f]{8}$/.test(head) ? Number.parseInt(head, 16) % 86400 : 0;
    return new Date(DERIVED_TIMESTAMP_BASE_MS + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 改写 core.xml 的创建与修改时间为确定值。
 * 找不到目标元素时直接失败：静默放过等于让墙上时钟继续泄进产物，
 * 幂等断言与 rendition 去重都会失效，属于必须 fail-closed 的场景（§3.3）。
 */
function rewriteCoreTimestamps(xml, timestamp) {
    const text = String(xml);
    const createdPattern = /(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/;
    const modifiedPattern = /(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/;
    if (!createdPattern.test(text) || !modifiedPattern.test(text)) {
        throw packageError('OOXML 核心属性中缺少 dcterms:created 或 dcterms:modified，无法固定文档时间戳，已拒绝输出不可复现的产物。', 'DOCX_PACKAGE_TIMESTAMP_MISSING');
    }
    return text
        .replace(createdPattern, `$1${timestamp}$2`)
        .replace(modifiedPattern, `$1${timestamp}$2`);
}

/** 解开 ZIP，返回全部文件条目（跳过目录条目）。 */
async function readZipEntries(buffer) {
    const directory = await unzipper.Open.buffer(buffer);
    const entries = [];
    for (const file of directory.files) {
        if (file.type === 'Directory') continue;
        entries.push({ name: String(file.path), data: await file.buffer() });
    }
    if (!entries.length) {
        throw packageError('OOXML 包内没有任何文件条目，渲染产物不可用。', 'DOCX_PACKAGE_EMPTY');
    }
    return entries;
}

/** 固定条目顺序：内容类型清单与根关系在前，其余按路径升序。 */
function orderEntries(entries) {
    const head = [];
    const rest = [];
    for (const entry of entries) {
        if (ENTRY_ORDER_HEAD.includes(entry.name)) head.push(entry);
        else rest.push(entry);
    }
    head.sort((left, right) => ENTRY_ORDER_HEAD.indexOf(left.name) - ENTRY_ORDER_HEAD.indexOf(right.name));
    rest.sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')));
    return [...head, ...rest];
}

/**
 * 用 STORE（不压缩）模式写出确定性 ZIP。
 * 不压缩的理由：DEFLATE 的输出依赖 zlib 版本与参数，跨环境不保证逐字节一致，
 * 而幂等断言要求的是内容摘要一致而不是体积最小；OOXML 允许 STORE 条目。
 */
function buildDeterministicZip(entries) {
    const ordered = orderEntries(entries);
    if (ordered.length > ZIP_MAX_ENTRIES) {
        throw packageError(`OOXML 包条目数（${ordered.length}）超过 ZIP 上限，已拒绝输出。`, 'DOCX_PACKAGE_TOO_MANY_ENTRIES');
    }
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of ordered) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
        if (data.length > ZIP_MAX_SIZE || offset > ZIP_MAX_SIZE) {
            throw packageError('OOXML 包体积超过 ZIP 的 4 GiB 上限，需要 ZIP64，已拒绝输出。', 'DOCX_PACKAGE_TOO_LARGE');
        }
        const checksum = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        // 通用标记位 0x0800：条目名按 UTF-8 编码。
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(FIXED_DOS_TIME, 10);
        local.writeUInt16LE(FIXED_DOS_DATE, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(FIXED_DOS_TIME, 12);
        central.writeUInt16LE(FIXED_DOS_DATE, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(ordered.length, 8);
    end.writeUInt16LE(ordered.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, ...centralParts, end]);
}

/**
 * 把 docx 库产出的包重打包为确定性产物。
 * timestamp 由调用方从 IR 摘要派生，写入 core.xml 的创建与修改时间。
 */
async function repackDeterministic(buffer, timestamp) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw packageError('待重打包的 OOXML 产物为空。', 'DOCX_PACKAGE_EMPTY');
    }
    const entries = await readZipEntries(buffer);
    const coreEntry = entries.find(entry => entry.name === CORE_PROPERTIES_PATH);
    if (!coreEntry) {
        throw packageError(`OOXML 包缺少 ${CORE_PROPERTIES_PATH}，无法固定文档时间戳。`, 'DOCX_PACKAGE_CORE_MISSING');
    }
    coreEntry.data = Buffer.from(rewriteCoreTimestamps(coreEntry.data.toString('utf8'), timestamp), 'utf8');
    return buildDeterministicZip(entries);
}

module.exports = {
    CORE_PROPERTIES_PATH,
    FIXED_DOS_DATE,
    FIXED_DOS_TIME,
    buildDeterministicZip,
    crc32,
    deriveDeterministicTimestamp,
    orderEntries,
    readZipEntries,
    repackDeterministic,
    rewriteCoreTimestamps
};
