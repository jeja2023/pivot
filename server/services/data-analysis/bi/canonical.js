'use strict';

const crypto = require('node:crypto');
const { biError } = require('./errors');
const { canonicalJson: serializeCanonicalJson } = require('../../canonical-json');

// 保持数组的业务顺序，只有对象属性排序；绝不规范化标签或原始文件的字节。
function canonicalJson(value) {
    const ancestors = new Set();
    let visited = 0;
    function validate(item, depth) {
        if (++visited > 100000 || depth > 64) throw biError('ANALYSIS_MODEL_CANONICAL_LIMIT', '模型定义嵌套或内容过多，请简化配置。');
        if (item === null) return;
        if (typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number') {
            if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) throw biError('ANALYSIS_MODEL_CANONICAL_NUMBER', '配置中的数值无效；高精度数值请使用字符串。');
            return;
        }
        if (typeof item !== 'object' || ancestors.has(item)) throw biError('ANALYSIS_MODEL_CANONICAL_INVALID', '模型配置包含不支持的值或循环引用。');
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
            throw biError('ANALYSIS_MODEL_CANONICAL_INVALID', '模型配置只接受普通 JSON 对象。');
        }
        ancestors.add(item);
        try {
            if (Object.getOwnPropertySymbols(item).length) throw biError('ANALYSIS_MODEL_CANONICAL_INVALID', '模型配置只接受 JSON 属性。');
            for (const key of Object.keys(item)) {
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                if (descriptor.get || descriptor.set) throw biError('ANALYSIS_MODEL_CANONICAL_INVALID', '模型配置不能包含属性访问器。');
            }
            if (Array.isArray(item)) {
                const keys = Object.keys(item);
                if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw biError('ANALYSIS_MODEL_CANONICAL_INVALID', '模型配置不接受稀疏数组或额外数组属性。');
                item.forEach(entry => validate(entry, depth + 1));
                return;
            }
            Object.keys(item).forEach(key => validate(item[key], depth + 1));
        } finally { ancestors.delete(item); }
    }
    validate(value, 0);
    return serializeCanonicalJson(value);
}

function canonicalHash(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

module.exports = { canonicalJson, canonicalHash };
