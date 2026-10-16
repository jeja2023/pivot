'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isDeferredForeignKeyError } = require('../server/db/schema/pg');

test('历史外键的列类型不兼容不会阻断 PostgreSQL 启动期架构补建', () => {
    assert.equal(isDeferredForeignKeyError({ code: '42804', message: '无法实现外键约束' }), true);
    assert.equal(isDeferredForeignKeyError({ code: '42830', message: 'incompatible types' }), true);
    assert.equal(isDeferredForeignKeyError({ code: '23503', message: 'insert or update violates foreign key constraint' }), false);
});
