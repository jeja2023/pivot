'use strict';
const SCALE = 100000000n;
function parse(value) {
    const text = String(value ?? '').trim();
    if (!/^-?\d{1,24}(?:\.\d{1,8})?$/.test(text)) throw new Error('金额应为最多八位小数的普通数字，不能包含科学计数、货币符号或千位分隔。');
    const negative = text.startsWith('-'); const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
    return negative ? -amount : amount;
}
function format(value) { const negative = value < 0n; const amount = negative ? -value : value; const fraction = (amount % SCALE).toString().padStart(8, '0').replace(/0+$/, '').padEnd(2, '0'); return `${negative ? '-' : ''}${amount / SCALE}.${fraction}`; }
const abs = value => value < 0n ? -value : value;
module.exports = { parse, format, abs };
