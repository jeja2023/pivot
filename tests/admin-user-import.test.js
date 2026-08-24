const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { iterateUserImportCsv } = require('../server/routes/admin-users');

test('管理员用户 CSV 导入流式解析支持引号换行并限制行数', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-admin-import-'));
    const filePath = path.join(root, 'users.csv');
    fs.writeFileSync(filePath, 'username,password,nickname,unit\nuser_one,Pass1234,"多行\n昵称",QA\nuser_two,Pass5678,普通用户,QA\nuser_three,Pass9999,超出,QA\n', 'utf8');
    try {
        const rows = [];
        for await (const row of iterateUserImportCsv(filePath, 3)) rows.push(row);
        assert.deepEqual(rows, [
            ['username', 'password', 'nickname', 'unit'],
            ['user_one', 'Pass1234', '多行\n昵称', 'QA'],
            ['user_two', 'Pass5678', '普通用户', 'QA']
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
