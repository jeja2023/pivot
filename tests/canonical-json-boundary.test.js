const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalJson } = require('../server/services/canonical-json');
const { computeIrDigest } = require('../server/services/document-ir');
const { canonicalJson: legacyCanonicalJson } = require('../server/services/agent-skills');

test('稳定 JSON 序列化独立于 Agent 技能域且兼容原有摘要结果', () => {
    const value = { z: [{ b: 2, a: 1 }], a: { y: true, x: null } };
    const expected = '{"a":{"x":null,"y":true},"z":[{"a":1,"b":2}]}' ;
    assert.equal(canonicalJson(value), expected);
    assert.equal(legacyCanonicalJson(value), expected);
    assert.equal(computeIrDigest(value), require('node:crypto').createHash('sha256').update(expected).digest('hex'));
    const root = path.resolve(__dirname, '..');
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'server', 'services', 'document-ir.js'), 'utf8'), /require\(['"]\.\/agent-skills['"]\)/);
});
