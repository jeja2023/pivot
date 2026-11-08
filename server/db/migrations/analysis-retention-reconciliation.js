'use strict';

module.exports = [{
    id: '202611070004_analysis_retention_reconciliation',
    description: 'Add durable bounded integrity cursors and findings for analysis objects and version bindings.',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_integrity_state (
            id TEXT PRIMARY KEY CHECK(id='main'),object_cursor TEXT NOT NULL DEFAULT '',
            scan_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_full_scan_at TIMESTAMPTZ,
            last_incremental_at TIMESTAMPTZ,last_error TEXT NOT NULL DEFAULT '',file_cursor TEXT NOT NULL DEFAULT '',
            manifest_cursor TEXT NOT NULL DEFAULT '',last_file_scan_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_integrity_findings (
            id TEXT PRIMARY KEY,kind TEXT NOT NULL,target_id TEXT NOT NULL,details_json JSONB NOT NULL DEFAULT '{}',
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at TIMESTAMPTZ,UNIQUE(kind,target_id)
        )`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_integrity_open ON analysis_integrity_findings(last_seen_at) WHERE resolved_at IS NULL');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_objects_integrity ON analysis_data_objects(verified_at,id) WHERE state=\'ready\'');
        await client.query("UPDATE analysis_data_objects SET expires_at=GREATEST(expires_at,COALESCE(ready_at,created_at)+CASE WHEN purpose='source' THEN INTERVAL '30 days' ELSE INTERVAL '7 days' END) WHERE state='ready'");
    }
}];
