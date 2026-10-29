'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const katex = require('../client/common/vendor/katex.min.js');

test('静态公式资源不继承原型上的 trust 选项', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'trust');
    Object.defineProperty(Object.prototype, 'trust', { value: true, configurable: true, writable: true });
    try {
        const result = katex.renderToString(String.raw`\href{javascript:alert(1)}{click}`, { throwOnError: false });
        assert.doesNotMatch(result, /<a\b/i);
        assert.equal(katex.version, '0.18.2');
    } finally {
        if (previous) Object.defineProperty(Object.prototype, 'trust', previous);
        else delete Object.prototype.trust;
    }
});
