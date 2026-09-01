/**
 * server/db/migrations/agent-artifact-delivery.js
 * 二进制产物 CAS、Rendition 与受控交付控制面（PostgreSQL-only）
 *
 * 落地方案 v1.2 §7.1、§7.3、§7.4、§7.6、§8.1：
 * 1. agent_artifact_objects 是二进制内容寻址存储的元数据表，storage_key 不对客户端暴露；
 * 2. agent_artifact_renditions 是不可变渲染产物（IR + 格式 + 渲染器版本 → 唯一内容）；
 * 3. agent_artifact_delivery_intents 复用 outbox 的 claim/ack/fail 三段范式，Web 下载与
 *    桌面端写入共用同一套意图与幂等模型；
 * 4. agent_local_devices / agent_local_output_grants 把设备身份与写入授权持久化，
 *    替代原先纯进程内存的 devices Map（C1、C7）；
 * 5. agent_artifact_delivery_events 是附加式审计事件，只保存目录末级提示，不保存终端绝对路径。
 *
 * 关于 tool_call_id 不加外键：agent_tool_calls 行在工具执行结束后才写入，
 * 而 rendition 在工具执行过程中产生，加外键会造成写入顺序死结。
 * 该列保存确定性的步骤标识（等于 agent_tool_calls.step_id），由服务层强制非空（R10）。
 */

const artifactCasMigration = {
    id: '202608310005_agent_artifact_binary_cas',
    description: 'Add binary artifact CAS metadata and immutable rendition records.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_artifact_objects (
                id VARCHAR(64) PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_digest CHAR(64) NOT NULL,
                mime_type VARCHAR(128) NOT NULL,
                byte_size BIGINT NOT NULL,
                storage_key TEXT NOT NULL,
                kind VARCHAR(24) NOT NULL DEFAULT 'blob',
                ref_count BIGINT NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, content_digest)
            );
            COMMENT ON TABLE agent_artifact_objects IS '二进制产物内容寻址存储元数据（IR、图片与渲染产物）';
            CREATE INDEX IF NOT EXISTS idx_agent_artifact_objects_tenant
                ON agent_artifact_objects(tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_artifact_objects_expiry
                ON agent_artifact_objects(expires_at) WHERE expires_at IS NOT NULL;

            CREATE TABLE IF NOT EXISTS agent_artifact_renditions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
                run_id VARCHAR(64) NOT NULL,
                tool_call_id VARCHAR(64) NOT NULL,
                created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                ir_ref TEXT NOT NULL,
                ir_digest CHAR(64) NOT NULL,
                format VARCHAR(16) NOT NULL,
                renderer_version VARCHAR(32) NOT NULL,
                content_digest CHAR(64) NOT NULL,
                mime_type VARCHAR(128) NOT NULL,
                byte_size BIGINT NOT NULL,
                storage_ref TEXT NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'ready',
                failure_reason TEXT NULL,
                expires_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, artifact_id, ir_digest, format, renderer_version)
            );
            COMMENT ON TABLE agent_artifact_renditions IS '产物渲染结果：同 IR 同格式同渲染器版本天然幂等且不可原地修改';
            CREATE INDEX IF NOT EXISTS idx_artifact_rendition_run
                ON agent_artifact_renditions (run_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_artifact_rendition_tenant
                ON agent_artifact_renditions (tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_artifact_rendition_tool_call
                ON agent_artifact_renditions (tool_call_id);

            CREATE TABLE IF NOT EXISTS agent_artifact_download_tokens (
                token_hash CHAR(64) PRIMARY KEY,
                rendition_id BIGINT NOT NULL REFERENCES agent_artifact_renditions(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id VARCHAR(64) NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            COMMENT ON TABLE agent_artifact_download_tokens IS '一次性短时下载令牌，绑定 rendition、用户与租户';
            CREATE INDEX IF NOT EXISTS idx_artifact_download_tokens_expiry
                ON agent_artifact_download_tokens (expires_at);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS agent_artifact_download_tokens;
            DROP TABLE IF EXISTS agent_artifact_renditions;
            DROP TABLE IF EXISTS agent_artifact_objects;
        `);
    }
};

const localDeviceMigration = {
    id: '202608310006_agent_local_device_registry',
    description: 'Persist local device identity, key attestation nonces and write-only output grants.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_local_devices (
                device_id VARCHAR(64) PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_name VARCHAR(128) NOT NULL DEFAULT '我的电脑',
                provider VARCHAR(32) NOT NULL DEFAULT 'desktop',
                public_key_pem TEXT NOT NULL,
                key_fingerprint CHAR(64) NOT NULL,
                key_version INTEGER NOT NULL DEFAULT 1,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                last_attested_at TIMESTAMPTZ NULL,
                last_seen_at TIMESTAMPTZ NULL,
                revoked_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            COMMENT ON TABLE agent_local_devices IS '本机设备注册表：设备身份由公钥指纹与 nonce 签名证明，不接受自报 deviceId';
            CREATE INDEX IF NOT EXISTS idx_agent_local_devices_user
                ON agent_local_devices (user_id, status, last_seen_at DESC);

            CREATE TABLE IF NOT EXISTS agent_local_device_nonces (
                nonce CHAR(64) PRIMARY KEY,
                device_id VARCHAR(64) NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                purpose VARCHAR(32) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            COMMENT ON TABLE agent_local_device_nonces IS '设备挑战 nonce：一次性使用，用于防重放';
            CREATE INDEX IF NOT EXISTS idx_agent_local_device_nonces_expiry
                ON agent_local_device_nonces (expires_at);

            CREATE TABLE IF NOT EXISTS agent_local_output_grants (
                id VARCHAR(64) PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL REFERENCES agent_local_devices(device_id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                path_hint VARCHAR(255) NOT NULL,
                allowed_formats JSONB NOT NULL DEFAULT '[]'::jsonb,
                max_bytes BIGINT NOT NULL DEFAULT 0,
                daily_quota_bytes BIGINT NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ NOT NULL,
                revoked_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            COMMENT ON TABLE agent_local_output_grants IS '本机写入目录授权：与只读授权分离，完整路径只保存在桌面端';
            CREATE INDEX IF NOT EXISTS idx_agent_local_output_grants_device
                ON agent_local_output_grants (device_id, revoked_at, expires_at);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS agent_local_output_grants;
            DROP TABLE IF EXISTS agent_local_device_nonces;
            DROP TABLE IF EXISTS agent_local_devices;
        `);
    }
};

const deliveryMigration = {
    id: '202608310007_agent_artifact_delivery',
    description: 'Add delivery intents with claim leases plus append-only delivery audit events.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_artifact_delivery_intents (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                rendition_id BIGINT NOT NULL REFERENCES agent_artifact_renditions(id) ON DELETE RESTRICT,
                run_id VARCHAR(64) NOT NULL,
                requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                channel VARCHAR(24) NOT NULL,
                device_id VARCHAR(64) NULL REFERENCES agent_local_devices(device_id) ON DELETE SET NULL,
                target_dir_grant VARCHAR(64) NULL,
                target_filename VARCHAR(255) NULL,
                allow_overwrite BOOLEAN NOT NULL DEFAULT FALSE,
                idempotency_key VARCHAR(128) NOT NULL,
                state VARCHAR(16) NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                claimed_by VARCHAR(128) NOT NULL DEFAULT '',
                claim_token_hash CHAR(64) NULL,
                lease_expires_at TIMESTAMPTZ NULL,
                confirmed_digest CHAR(64) NULL,
                confirmed_path_hint VARCHAR(255) NULL,
                failure_code VARCHAR(64) NULL,
                failure_reason TEXT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, requested_by, idempotency_key),
                CONSTRAINT agent_delivery_local_device_check
                    CHECK (channel <> 'local_device' OR (device_id IS NOT NULL AND target_dir_grant IS NOT NULL))
            );
            COMMENT ON TABLE agent_artifact_delivery_intents IS '产物交付意图：只能由用户操作创建，Agent 不得创建';
            CREATE INDEX IF NOT EXISTS idx_agent_delivery_intents_claimable
                ON agent_artifact_delivery_intents (device_id, state, expires_at);
            CREATE INDEX IF NOT EXISTS idx_agent_delivery_intents_tenant
                ON agent_artifact_delivery_intents (tenant_id, state, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_artifact_delivery_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                intent_id BIGINT NULL REFERENCES agent_artifact_delivery_intents(id) ON DELETE SET NULL,
                rendition_id BIGINT NULL REFERENCES agent_artifact_renditions(id) ON DELETE SET NULL,
                run_id VARCHAR(64) NOT NULL DEFAULT '',
                tool_call_id VARCHAR(64) NULL,
                actor_type VARCHAR(16) NOT NULL,
                actor_id VARCHAR(64) NOT NULL,
                event_type VARCHAR(32) NOT NULL,
                channel VARCHAR(24) NULL,
                device_id VARCHAR(64) NULL,
                path_hint VARCHAR(255) NULL,
                content_digest CHAR(64) NULL,
                decision_reason TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            COMMENT ON TABLE agent_artifact_delivery_events IS '交付审计事件：附加式，仅保存目录末级提示与文件名';
            CREATE INDEX IF NOT EXISTS idx_delivery_events_run
                ON agent_artifact_delivery_events (run_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_delivery_events_tenant
                ON agent_artifact_delivery_events (tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_delivery_events_digest
                ON agent_artifact_delivery_events (content_digest);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS agent_artifact_delivery_events;
            DROP TABLE IF EXISTS agent_artifact_delivery_intents;
        `);
    }
};

module.exports = [artifactCasMigration, localDeviceMigration, deliveryMigration];
