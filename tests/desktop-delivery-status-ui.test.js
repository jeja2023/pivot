const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('受控文件交付状态弹窗仅保留右下角关闭按钮', () => {
    const html = read('desktop/delivery-status.html');
    const titlebar = html.match(/<div class="titlebar">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(titlebar, /<button/);
    assert.doesNotMatch(html, /id="btn-title-close"/);
    assert.match(html, /id="btn-close"[^>]*>关闭<\/button>/);
    assert.match(html, /document\.getElementById\('btn-close'\)\.addEventListener\('click', closeWindow\)/);
});
