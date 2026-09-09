const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TABLE_COMMENTS,
    COLUMN_COMMENTS,
    buildPgCommentStatements,
    quotePgComment
} = require('../server/db/schema/comments');

test('schema comments load their static dictionary without changing generated SQL', () => {
    assert.ok(Object.keys(TABLE_COMMENTS).length >= 80);
    assert.ok(Object.keys(COLUMN_COMMENTS).length >= 80);
    const statements = buildPgCommentStatements();
    assert.ok(statements.some(statement => statement === 'COMMENT ON TABLE "users" IS \'系统用户主表（包含账号、身份、权限角色及状态）\';'));
    assert.ok(statements.some(statement => statement.startsWith('COMMENT ON COLUMN "users"."username" IS')));
});

test('schema comments quote PostgreSQL single quotes safely', () => {
    assert.equal(quotePgComment("O'Reilly"), "O''Reilly");
});
