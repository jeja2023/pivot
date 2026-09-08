const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneRuntimeModules } = require('../scripts/prune_runtime_modules');

test('运行时依赖裁剪仅删除白名单中的纯类型和浏览器包', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-prune-runtime-'));
    const nodeModules = path.join(root, 'node_modules');
    try {
        fs.mkdirSync(path.join(nodeModules, '@types', 'node'), { recursive: true });
        fs.mkdirSync(path.join(nodeModules, '@azure', 'msal-browser', 'dist'), { recursive: true });
        fs.mkdirSync(path.join(nodeModules, 'keep-me'), { recursive: true });
        fs.writeFileSync(path.join(nodeModules, '@types', 'node', 'index.d.ts'), 'declare const pivot: string;');
        fs.writeFileSync(path.join(nodeModules, '@azure', 'msal-browser', 'dist', 'index.js'), 'module.exports = {};');
        fs.writeFileSync(path.join(nodeModules, 'keep-me', 'index.js'), 'module.exports = true;');

        const result = pruneRuntimeModules(nodeModules, { verifyAzureIdentity: false });

        assert.deepEqual(result.removed, ['@types', '@azure/msal-browser']);
        assert.equal(fs.existsSync(path.join(nodeModules, '@types')), false);
        assert.equal(fs.existsSync(path.join(nodeModules, '@azure', 'msal-browser')), false);
        assert.equal(fs.existsSync(path.join(nodeModules, 'keep-me', 'index.js')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
