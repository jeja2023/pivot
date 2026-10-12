'use strict';

// 已部署环境可能已经执行法规治理基础迁移；订阅和义务清单使用独立迁移补齐，
// 使发布后的数据库无需依赖修改历史迁移文件。
module.exports = [{
    id: '202610120004_regulations_collaboration',
    description: 'Add regulation update subscriptions and reviewed obligation records.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS regulation_subscriptions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'active',
                approved_only BOOLEAN NOT NULL DEFAULT TRUE,
                last_notified_version_id BIGINT REFERENCES regulation_versions(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, document_id)
            );
            CREATE TABLE IF NOT EXISTS regulation_obligations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                version_id BIGINT NOT NULL REFERENCES regulation_versions(id) ON DELETE CASCADE,
                article_id BIGINT NOT NULL REFERENCES regulation_articles(id) ON DELETE CASCADE,
                subject TEXT NOT NULL DEFAULT '',
                trigger_condition TEXT NOT NULL DEFAULT '',
                required_action TEXT NOT NULL DEFAULT '',
                due_rule TEXT NOT NULL DEFAULT '',
                evidence_requirement TEXT NOT NULL DEFAULT '',
                owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                review_status TEXT NOT NULL DEFAULT 'pending',
                created_by_user BIGINT NOT NULL DEFAULT 0,
                reviewed_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_regulation_subscriptions_document
                ON regulation_subscriptions(document_id, status, user_id);
            CREATE INDEX IF NOT EXISTS idx_regulation_obligations_article
                ON regulation_obligations(article_id, status, review_status);
        `);
    }
}];
