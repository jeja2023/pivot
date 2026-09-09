/**
 * 数据库表级与字段级中文注释的运行时入口。
 *
 * 大型静态字典独立存放在 comments.data.json，避免把纯数据计入生产 JS
 * 职责与行数治理；此模块仅保留 PostgreSQL COMMENT 语句的生成行为。
 */
const { TABLE_COMMENTS, COLUMN_COMMENTS } = require('./comments.data.json');

function quotePgComment(value) {
    return String(value || '').replace(/'/g, "''");
}

function buildPgCommentStatements() {
    const statements = [];
    for (const [table, comment] of Object.entries(TABLE_COMMENTS)) {
        statements.push(`COMMENT ON TABLE "${table}" IS '${quotePgComment(comment)}';`);
    }
    for (const [table, columns] of Object.entries(COLUMN_COMMENTS)) {
        for (const [column, comment] of Object.entries(columns)) {
            statements.push(`COMMENT ON COLUMN "${table}"."${column}" IS '${quotePgComment(comment)}';`);
        }
    }
    return statements;
}

module.exports = {
    TABLE_COMMENTS,
    COLUMN_COMMENTS,
    buildPgCommentStatements,
    quotePgComment
};
