'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runPowerShellSignatureQuery } = require('../desktop/updater');

test('Windows 更新验签查询使用有界超时并把系统验证停滞报告为明确错误', async () => {
    let timeout;
    await assert.rejects(runPowerShellSignatureQuery('C:\\updates\\Pivot Setup.exe', {
        execFileFn(_executable, _args, options, callback) {
            timeout = options.timeout;
            callback(Object.assign(new Error('系统签名查询未结束'), { killed: true }), '', '');
        }
    }), /签名校验超时/);
    assert.equal(timeout, 30000);
});
