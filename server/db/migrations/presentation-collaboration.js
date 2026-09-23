'use strict';

/**
 * PPT 制作应用：评论线程与协作者。
 *
 * 为演示文稿提供按页/按元素的评论线程（支持主评、回复、标记解决）以及协作者关系。
 */
const presentationCollaborationMigration = {
    id: '202609230001_presentation_collaboration_foundation',
    description: 'Add presentation comments and presentation collaborators tables.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_comments (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                slide_id VARCHAR(64) NOT NULL DEFAULT '',
                element_id VARCHAR(64) NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                parent_id BIGINT NULL REFERENCES presentation_comments(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'open',
                resolved_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
                resolved_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ NULL,
                CONSTRAINT presentation_comment_status_check CHECK (status IN ('open', 'resolved'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_comments_doc_slide
                ON presentation_comments (presentation_id, slide_id, deleted_at, created_at ASC);

            CREATE TABLE IF NOT EXISTS presentation_collaborators (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role VARCHAR(32) NOT NULL DEFAULT 'editor',
                invited_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (presentation_id, user_id),
                CONSTRAINT presentation_collaborator_role_check CHECK (role IN ('editor', 'viewer', 'commenter'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_collaborators_user
                ON presentation_collaborators (user_id, presentation_id);
        `);
    }
};

module.exports = presentationCollaborationMigration;
