'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingTransactionExecutors } = require('../scripts/transaction-executor-check');

test('架构门禁拒绝缺少 executor 的数据库事务，不匹配注释和字符串', () => {
    assert.deepEqual(findMissingTransactionExecutors('transaction(async () => { await execute(sql); });'),[1]);
    assert.deepEqual(findMissingTransactionExecutors('transaction(async trx => { await trx.execute(sql); });'),[]);
    assert.deepEqual(findMissingTransactionExecutors('transaction(async trx => { await execute(sql); });'),[1]);
    assert.deepEqual(findMissingTransactionExecutors('transaction(async ({execute}) => { await execute(sql); });'),[]);
    assert.deepEqual(findMissingTransactionExecutors('// transaction(async () => {})\nconst text="transaction(() => {})";'),[]);
});
