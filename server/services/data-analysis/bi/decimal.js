'use strict';

const { biError } = require('./errors');
const { BI_POLICY } = require('./policy');

function invalid(message = '数值不能按指定的十进制规则解析，请检查字段类型。') {
    return biError('ANALYSIS_MODEL_NUMERIC_INVALID', message);
}

function scaleOption(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > BI_POLICY.maxDecimalPrecision) throw invalid('十进制小数位必须为 0 至 38 的整数。');
    return value;
}

function power(scale) {
    // 除法对齐可产生最多 76 位中间整数；输出仍必须通过 38 位精度检查。
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > BI_POLICY.maxDecimalPrecision * 2) throw invalid('十进制中间精度无效。');
    return 10n ** BigInt(scale);
}

function checked(coefficient, scale, precision = BI_POLICY.maxDecimalPrecision) {
    scaleOption(scale);
    if (!Number.isSafeInteger(precision) || precision < 1 || precision > BI_POLICY.maxDecimalPrecision || scale > precision) throw invalid('十进制精度配置无效。');
    if ((coefficient < 0n ? -coefficient : coefficient) >= power(precision)) throw biError('ANALYSIS_MODEL_NUMERIC_OVERFLOW', '计算超出十进制精度范围，请调整字段精度或查询范围。');
    return Object.freeze({ coefficient, scale });
}

// 除法和缩小精度均使用半值远离零；中间结果保持整数，避免浮点数二次舍入。
function divideRounded(numerator, denominator) {
    if (denominator === 0n) return null;
    const negative = (numerator < 0n) !== (denominator < 0n);
    const dividend = numerator < 0n ? -numerator : numerator;
    const divisor = denominator < 0n ? -denominator : denominator;
    const quotient = dividend / divisor + ((dividend % divisor) * 2n >= divisor ? 1n : 0n);
    return negative ? -quotient : quotient;
}

function rescaleDecimal(value, scale, precision = BI_POLICY.maxDecimalPrecision) {
    if (value === null) return null;
    scaleOption(scale);
    const coefficient = scale >= value.scale
        ? value.coefficient * power(scale - value.scale)
        : divideRounded(value.coefficient, power(value.scale - scale));
    return checked(coefficient, scale, precision);
}

function parseDecimal(value, options = {}) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number') throw invalid();
    // 二进制浮点输入一旦丢失原精度便无法修复；金额只接受文本或安全整数。
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid('精确数值请以十进制字符串传入，不能使用浮点数。');
    let text = String(value).trim();
    if (!text) return null;
    if (text.length > 128) throw invalid();
    let negative = false;
    if (text.startsWith('-') || text.startsWith('+')) { negative = text[0] === '-'; text = text.slice(1); }
    if (options.allowCurrency && /^[￥¥$]/u.test(text)) text = text.slice(1);
    const percent = options.allowPercent === true && text.endsWith('%');
    if (percent) text = text.slice(0, -1);
    if (text.includes(',')) {
        if (!options.allowThousands || !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) throw invalid();
        text = text.replace(/,/g, '');
    }
    if (!/^\d+(?:\.\d+)?$/.test(text)) throw invalid();
    const [integer, fraction = ''] = text.split('.');
    const scale = fraction.length + (percent ? 2 : 0);
    const coefficient = BigInt(integer + fraction) * (negative ? -1n : 1n);
    const result = checked(coefficient, scale);
    return options.scale === undefined ? result : rescaleDecimal(result, options.scale, options.precision);
}

function formatDecimal(value, options = {}) {
    if (value === null) return null;
    const result = options.scale === undefined ? value : rescaleDecimal(value, options.scale, options.precision);
    const magnitude = result.coefficient < 0n ? -result.coefficient : result.coefficient;
    const digits = magnitude.toString().padStart(result.scale + 1, '0');
    const body = result.scale ? `${digits.slice(0, -result.scale)}.${digits.slice(-result.scale)}` : digits;
    return `${result.coefficient < 0n ? '-' : ''}${body}`;
}

function decimalAdd(left, right) {
    if (left === null || right === null) return null;
    const scale = Math.max(left.scale, right.scale);
    return checked(left.coefficient * power(scale - left.scale) + right.coefficient * power(scale - right.scale), scale);
}

function decimalSubtract(left, right) {
    if (left === null || right === null) return null;
    return decimalAdd(left, { coefficient: -right.coefficient, scale: right.scale });
}

function decimalMultiply(left, right) {
    if (left === null || right === null) return null;
    return checked(left.coefficient * right.coefficient, left.scale + right.scale);
}

function decimalDivide(left, right, scale = 8) {
    if (left === null || right === null || right.coefficient === 0n) return null;
    scaleOption(scale);
    const shift = right.scale + scale - left.scale;
    const numerator = left.coefficient * (shift >= 0 ? power(shift) : 1n);
    const denominator = right.coefficient * (shift < 0 ? power(-shift) : 1n);
    return checked(divideRounded(numerator, denominator), scale);
}

function decimalFromRatio(numerator, denominator, scale, precision = BI_POLICY.maxDecimalPrecision) {
    scaleOption(scale);
    if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') throw invalid('精确比率必须使用整数分子与分母。');
    if (denominator === 0n) return null;
    return checked(divideRounded(numerator * power(scale), denominator), scale, precision);
}

function compareDecimals(left, right) {
    if (left === null || right === null) throw invalid('空值不能参与十进制比较。');
    const scale = Math.max(left.scale, right.scale);
    const delta = left.coefficient * power(scale - left.scale) - right.coefficient * power(scale - right.scale);
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

module.exports = { parseDecimal, formatDecimal, rescaleDecimal, decimalAdd, decimalSubtract, decimalMultiply, decimalDivide, decimalFromRatio, compareDecimals };
