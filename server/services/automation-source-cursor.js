'use strict';
// @ts-check
const fs = require('node:fs/promises');
const path = require('node:path');

function numberParts(value) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return null;
    const integer = match[2].replace(/^0+(?=\d)/, ''), fraction = (match[3] || '').replace(/0+$/, '');
    return { negative: match[1] === '-' && (integer !== '0' || Boolean(fraction)), integer, fraction };
}

function compareNumber(left, right) {
    if (left.negative !== right.negative) return left.negative ? -1 : 1;
    let result = Math.sign(left.integer.length - right.integer.length);
    if (!result && left.integer !== right.integer) result = left.integer > right.integer ? 1 : -1;
    const width = Math.max(left.fraction.length, right.fraction.length);
    if (!result) { const a = left.fraction.padEnd(width, '0'), b = right.fraction.padEnd(width, '0'); result = a === b ? 0 : a > b ? 1 : -1; }
    return left.negative ? -result : result;
}

function timestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null;
    let iso = value.replace(' ', 'T');
    if (iso.length === 10) iso += 'T00:00:00';
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += '+08:00';
    const milliseconds = Date.parse(iso);
    if (!Number.isFinite(milliseconds)) return null;
    const fraction = /\.(\d+)/.exec(value)?.[1] || '';
    return BigInt(milliseconds) * 1000000n + BigInt(fraction.slice(3).padEnd(6, '0') || '0');
}

/**
 * 从同类水位值中选择最大值，保留原始精度。
 * @param {Array<string | number | bigint | Date | null | undefined>} values 候选水位值
 * @param {string} [fallback] 无候选值时沿用的水位
 */
function selectNextWatermark(values, fallback = '') {
    const items = values.filter(value => value !== null && value !== undefined && String(value).trim() !== '')
        .map(value => value instanceof Date ? value.toISOString() : String(value).trim());
    if (!items.length) return fallback;
    const numbers = items.map(numberParts), times = items.map(timestamp);
    const compare = numbers.every(Boolean) ? (a, b) => compareNumber(numbers[a], numbers[b])
        : times.every(value => value !== null) ? (a, b) => times[a] === times[b] ? 0 : times[a] > times[b] ? 1 : -1
            : (a, b) => items[a] === items[b] ? 0 : items[a] > items[b] ? 1 : -1;
    let selected = 0;
    for (let index = 1; index < items.length; index++) if (compare(index, selected) > 0) selected = index;
    return items[selected];
}

/**
 * 按文件名游标读取有界批次，在末尾回绕。
 * @param {string} directory 监听目录
 * @param {{cursor?: string, extensions?: string[], limit?: number}} [options] 扫描条件
 */
async function scanFileBatch(directory, { cursor = '', extensions = [], limit = 100 } = {}) {
    const allowed = new Set(extensions.map(extension => String(extension).replace(/^\./, '').toLowerCase()));
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()
        && (!allowed.size || allowed.has(path.extname(entry.name).slice(1).toLowerCase())))
        .sort((a, b) => a.name === b.name ? 0 : a.name < b.name ? -1 : 1);
    const start = entries.findIndex(entry => entry.name > cursor);
    // 到达目录末尾后回绕，晚到文件及失败文件下一轮仍可被重新检查。
    return entries.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + Math.max(1, Math.min(500, limit)));
}

module.exports = { selectNextWatermark, scanFileBatch };
