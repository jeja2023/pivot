'use strict';

module.exports = [{
    id: '202611070013_analysis_source_metadata',
    description: '随不可变数据版本保留批次、业务期间、截止时间与覆盖状态，固定导入合同。',
    async upPg(client) {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        await client.query("ALTER TABLE analysis_ingestion_sessions ADD COLUMN IF NOT EXISTS source_metadata_json JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(source_metadata_json)='object')");
        await client.query(`DROP TRIGGER IF EXISTS analysis_dataset_version_immutable ON analysis_dataset_versions;
            CREATE TRIGGER analysis_dataset_version_immutable BEFORE UPDATE ON analysis_dataset_versions FOR EACH ROW EXECUTE FUNCTION analysis_reject_snapshot_update()`);
        await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_dataset_append_batch ON analysis_dataset_versions(dataset_id,(manifest_json->>'inputBatchId')) WHERE operation='append' AND COALESCE(manifest_json->>'inputBatchId','')<>''");
    },
    async checkPg(client) {
        const { rows } = await client.query(`SELECT
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_ingestion_sessions' AND column_name='source_metadata_json' AND is_nullable='NO') AS metadata,
            EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='analysis_dataset_versions'::regclass AND tgname='analysis_dataset_version_immutable' AND tgenabled='O') AS protected,
            EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('idx_analysis_dataset_append_batch') AND indisvalid AND indisunique) AS batches`);
        return Boolean(rows[0]?.metadata && rows[0]?.protected && rows[0]?.batches);
    }
}];
