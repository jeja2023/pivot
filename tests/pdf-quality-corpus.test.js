const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PDFDocument, degrees } = require('pdf-lib');

// 60 份可重复生成的非敏感质量夹具。它们不包含业务文件，因此可在 CI 与离线环境
// 重建；真实客户文件仍只允许在经授权的试点环境中验证。
const CATEGORIES = Object.freeze([
    ['文本-单页', 1, [595, 842]], ['文本-多页', 3, [595, 842]], ['文本-长文', 6, [595, 842]],
    ['中文', 1, [595, 842]], ['中英混排', 3, [595, 842]], ['数字金额日期', 6, [595, 842]],
    ['横向', 1, [842, 595]], ['A3', 3, [842, 1191]], ['小尺寸', 6, [320, 240]],
    ['旋转90度', 1, [595, 842], 90], ['旋转180度', 3, [595, 842], 180], ['旋转270度', 6, [595, 842], 270],
    ['裁切框', 1, [595, 842], 0, true], ['页面顺序', 3, [595, 842]], ['页码范围', 6, [595, 842]],
    ['批量名称冲突', 1, [595, 842]], ['表单占位', 3, [595, 842]], ['批注占位', 6, [595, 842]],
    ['大页数20', 20, [595, 842]], ['大页数100', 100, [595, 842]]
]);

const QUALITY_FIXTURES = Object.freeze(CATEGORIES.flatMap(([category, pages, size, rotation = 0, cropped = false]) => [
    'a', 'b', 'c'
].map(variant => ({ id: `${category}-${variant}`, category, pages, size, rotation, cropped }))));

async function createFixture(filePath, fixture) {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < fixture.pages; index += 1) {
        const page = pdf.addPage(fixture.size);
        page.drawText(`Fixture page ${index + 1}`, { x: 24, y: Math.max(24, fixture.size[1] - 48), size: 12 });
        if (fixture.rotation) page.setRotation(degrees(fixture.rotation));
        if (fixture.cropped) page.setCropBox(12, 12, fixture.size[0] - 24, fixture.size[1] - 24);
    }
    fs.writeFileSync(filePath, await pdf.save());
}

test('PDF 质量基准集包含 60 份可重复生成夹具并覆盖页面几何与规模边界', async () => {
    assert.equal(QUALITY_FIXTURES.length, 60);
    assert.equal(new Set(QUALITY_FIXTURES.map(item => item.category)).size, 20);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-pdf-quality-'));
    try {
        for (const [fixtureIndex, fixture] of QUALITY_FIXTURES.entries()) {
            const filePath = path.join(directory, `${fixtureIndex}-${fixture.id.replace(/[^\w.-]+/g, '-')}.pdf`);
            await createFixture(filePath, fixture);
            const loaded = await PDFDocument.load(fs.readFileSync(filePath));
            assert.equal(loaded.getPageCount(), fixture.pages, fixture.id);
            const first = loaded.getPage(0);
            assert.equal(Math.round(first.getWidth()), fixture.size[0], fixture.id);
            assert.equal(Math.round(first.getHeight()), fixture.size[1], fixture.id);
            assert.equal(first.getRotation().angle, fixture.rotation, fixture.id);
            if (fixture.cropped) assert.ok(first.getCropBox().width < first.getWidth(), fixture.id);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

module.exports = { QUALITY_FIXTURES };
