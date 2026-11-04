// 摘要列用于真正的服务端分页；产物绑定单独存储，客户端不能跨公文改绑。
module.exports = [{
    id: '202611040001_official_writing_library',
    description: 'Add paged writing summaries and document-owned export bindings.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE official_writing_documents ADD COLUMN IF NOT EXISTS summary JSONB NOT NULL DEFAULT '{}';
            ALTER TABLE official_writing_documents ADD COLUMN IF NOT EXISTS artifact_id BIGINT REFERENCES agent_artifacts(id) ON DELETE SET NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_official_writing_artifact ON official_writing_documents(artifact_id) WHERE artifact_id IS NOT NULL;
            COMMENT ON COLUMN official_writing_documents.summary IS '公文列表摘要，不包含正文材料及历史';
            COMMENT ON COLUMN official_writing_documents.artifact_id IS '本篇公文的独立导出产物，服务端管理';
        `);
        // 旧数据由共享规则回填，保证列表与详情使用相同口径。原正文不改写。
        const model = require('../../../client/common/official-writing-document');
        let cursor = 0;
        while (true) {
            const result = await client.query('SELECT id, state FROM official_writing_documents WHERE id > $1 ORDER BY id LIMIT 200', [cursor]);
            if (!result.rows.length) break;
            for (const row of result.rows) {
                let state = {};
                try { state = JSON.parse(row.state); } catch (_) {}
                await client.query('UPDATE official_writing_documents SET summary = $1 WHERE id = $2', [JSON.stringify(model.summary(state)), row.id]);
                cursor = row.id;
            }
        }
    }
}];
