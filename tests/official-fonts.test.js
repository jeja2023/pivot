const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const format = require('../client/common/official-writing-format');
const { renderDocx } = require('../server/services/document-rendering/docx-renderer');
const { renderPdf } = require('../server/services/document-rendering/pdf-renderer');
const { officialFontStatus } = require('../server/services/document-rendering/official-fonts');
const { fixture, officialFontsOrSkip } = require('./helpers/official-writing-rendering');

test('缺少公文原字体时 DOCX/PDF 均拒绝导出并返回明确的 503', async (t) => {
    // 独立测试进程内模拟空字体目录，也覆盖 Windows 已安装字体的环境。
    t.mock.method(fs, 'readdir', async () => []);
    const status = await officialFontStatus();
    assert.equal(status.available, false);
    assert.equal(status.profile, format.ID);
    for (const font of Object.values(format.FONT)) assert.ok(status.error.includes(font), font);
    for (const render of [renderDocx, renderPdf]) {
        for (const layout of ['plain', 'red_header']) {
            await assert.rejects(() => render(fixture(layout)), error => {
                assert.equal(error.status, 503);
                assert.equal(error.code, 'OFFICIAL_FONTS_UNAVAILABLE');
                for (const font of Object.values(format.FONT)) assert.ok(error.message.includes(font), font);
                return true;
            });
        }
    }
});

test('字体读取发生非缺失异常时，渲染测试必须失败而非跳过', async (t) => {
    const error = Object.assign(new Error('字体文件读取失败'), { code: 'EIO' });
    t.mock.method(fs, 'readdir', async () => ['FZXBSK.TTF']);
    t.mock.method(fs, 'stat', async () => { throw error; });
    const skipped = [];
    await assert.rejects(() => officialFontsOrSkip({ skip: reason => skipped.push(reason) }), failure => failure === error);
    assert.deepEqual(skipped, []);
});
