'use strict';

const { redactSecrets } = require('../security');

function redactDiagnostic(value, depth = 0) {
    if (depth > 8) return '[已省略]';
    if (typeof value === 'string') return redactSecrets(value)
        .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已脱敏]')
        .replace(/\b(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]+/gi, '$1?[已脱敏]')
        .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '$1://[已脱敏]');
    if (Array.isArray(value)) return value.map(item => redactDiagnostic(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(redactSecrets(value)).map(([key, item]) => [key, redactDiagnostic(item, depth + 1)]));
    return value;
}

module.exports = { redactDiagnostic };
