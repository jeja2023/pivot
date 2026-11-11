'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { selectNextWatermark, scanFileBatch } = require('../server/services/automation-source-cursor');

test('增量水位线保持整数、精确小数、时区与微秒顺序，不丢大整数尾数', () => {
    assert.equal(selectNextWatermark([9, 10]), '10');
    assert.equal(selectNextWatermark(['9007199254740993', '9007199254740992']), '9007199254740993');
    assert.equal(selectNextWatermark(['-9.1', '-9.01', '-10', '-0.01']), '-0.01');
    assert.equal(selectNextWatermark(['100.00000000000001', '100.00000000000002']), '100.00000000000002');
    assert.equal(selectNextWatermark(['2026-11-10 10:00:00.123455', '2026-11-10T02:00:00.123456Z']), '2026-11-10T02:00:00.123456Z');
    assert.equal(selectNextWatermark([null, ''], '原水位'), '原水位');
});

test('有界文件批次越过已处理窗口并回绕，扩展名筛选先于批次上限', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-trigger-cursor-'));
    try {
        await Promise.all(Array.from({ length: 121 }, (_, index) => fs.writeFile(path.join(directory, `${String(index).padStart(4, '0')}.txt`), '测试')));
        await Promise.all(Array.from({ length: 120 }, (_, index) => fs.writeFile(path.join(directory, `0-other-${index}.bin`), '无关格式')));
        const first = await scanFileBatch(directory, { extensions: ['txt'], limit: 100 });
        assert.equal(first.length, 100);
        const second = await scanFileBatch(directory, { extensions: ['txt'], cursor: first.at(-1).name, limit: 100 });
        assert.equal(second.length, 21); assert.equal(second.at(-1).name, '0120.txt');
        const wrapped = await scanFileBatch(directory, { extensions: ['txt'], cursor: second.at(-1).name, limit: 100 });
        assert.equal(wrapped[0].name, '0000.txt');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
