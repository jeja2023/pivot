/**
 * server/services/agent-artifact-cas.js
 * 二进制产物 CAS：Document IR、图片与 DOCX/PDF/XLSX 渲染产物的唯一持久化入口
 *
 * 落地方案 v1.2 §7.1、§2.3-C8、阶段 2.2、风险 R13：
 * 1. 现有 agent-blob-store 只能存 JSON/文本、64KB 以下直接返回 ref:null，
 *    没有 MIME、流式、ACL 与保留期，无法承载 IR 与二进制制品，故另建本模块；
 *    这里只沿用它的目录约定、sha256 命名与 0700/0600 权限模式，不调用 putAgentBlob；
 * 2. 权威元数据在 agent_artifact_objects；storage_key 不对客户端暴露，
 *    读取一律先过租户与归属校验（fail-closed），不接受凭裸路径或裸引用读取；
 * 3. 同租户同摘要幂等复用既有行与文件；不同租户各存一份对象行，
 *    禁止用共享 storage_key 代替租户授权（§7.1 末段）；
 * 4. 保留期到点只删 blob、保留元数据行，以维持审计链完整（§7.3）；
 * 5. 引用计数由调用方在建立/解除引用时显式维护，回收要求 ref_count<=0 且保留期已过。
 */
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const store = require('./agent-artifact-cas-store');

const { casError } = store;

/** 受控引用前缀。IR 中的图片、rendition 的 ir_ref / storage_ref 全部使用这一种地址。 */
const CAS_REF_PREFIX = 'artifact-cas://';

/** 保留期到点后的对象状态：blob 已清理，元数据行仍在，供审计反查。 */
const KIND_EXPIRED = 'expired';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RETENTION_DAYS = 3650;

/** 与 document-ir.js 的 CAS_REF_PATTERN 保持一致（不 require 该模块，避免服务间循环依赖）。 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{16,64}$/;

/** kind 落在 VARCHAR(24)，用白名单字符而非白名单取值，避免与调用方的产物分类词表耦合。 */
const KIND_PATTERN = /^[a-z0-9_]{1,24}$/;

/** MIME 落在 VARCHAR(128)，只接受 type/subtype 以及可选的 charset 参数。 */
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+*-]{0,62}(?:; charset=[a-z0-9-]{1,32})?$/;

/** 单个对象的字节上限，超限即拒绝（R9：CAS 不能成为新的资源消耗点）。 */
function maxObjectBytes(env = process.env) {
    return Math.max(1024, Number.parseInt(env.PIVOT_ARTIFACT_MAX_BYTES, 10) || DEFAULT_MAX_BYTES);
}

/** 存储根目录（转发给文件系统层，供运维与自检使用）。 */
function casRoot() {
    return store.casRoot();
}

function buildCasRef(objectId) {
    const id = String(objectId || '').trim().toLowerCase();
    if (!OBJECT_ID_PATTERN.test(id)) {
        throw casError('产物对象标识非法，无法构造受控引用。', 500, 'ARTIFACT_CAS_ID_INVALID');
    }
    return `${CAS_REF_PREFIX}${id}`;
}

/** 解析受控引用；不是合法引用一律返回 null，由调用方决定拒绝方式。 */
function parseCasRef(ref) {
    const text = String(ref || '').trim();
    if (!text.startsWith(CAS_REF_PREFIX)) return null;
    const id = text.slice(CAS_REF_PREFIX.length).trim().toLowerCase();
    return OBJECT_ID_PATTERN.test(id) ? id : null;
}

/** 对象 id = sha256(`租户 id:内容摘要`)，稳定可复算，且不泄露其他租户的对象地址。 */
function computeObjectId(tenantId, digest) {
    const tenant = store.tenantSegment(tenantId);
    return crypto.createHash('sha256').update(`${tenant}:${store.assertDigest(digest)}`).digest('hex');
}

/** 同时接受 { objectId }、{ ref } 与直接传入的字符串，便于调用方原样传库里存的 ref。 */
function resolveObjectId(input) {
    const source = input && typeof input === 'object' ? input : {};
    const candidates = [source.objectId, source.ref, typeof input === 'string' ? input : null];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const text = String(candidate).trim().toLowerCase();
        if (!text) continue;
        if (OBJECT_ID_PATTERN.test(text)) return text;
        const parsed = parseCasRef(text);
        if (parsed) return parsed;
    }
    return null;
}

function normalizeUserId(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw casError('产物对象缺少有效的归属用户标识。', 400, 'ARTIFACT_CAS_OWNER_INVALID');
    }
    return parsed;
}

function normalizeMimeType(mimeType) {
    const text = String(mimeType || '').trim().toLowerCase().replace(/\s*;\s*/g, '; ');
    if (!text) throw casError('产物对象必须声明 MIME 类型。', 400, 'ARTIFACT_CAS_MIME_REQUIRED');
    if (text.length > 128 || !MIME_PATTERN.test(text)) {
        throw casError(`产物对象的 MIME 类型不受支持：${text.slice(0, 60)}`, 400, 'ARTIFACT_CAS_MIME_INVALID');
    }
    return text;
}

function normalizeKind(kind) {
    const text = String(kind || 'blob').trim().toLowerCase();
    if (text === KIND_EXPIRED) {
        throw casError('该产物对象类型为保留期回收状态专用，不能直接写入。', 400, 'ARTIFACT_CAS_KIND_RESERVED');
    }
    if (!KIND_PATTERN.test(text)) {
        throw casError('产物对象类型只能是 24 位以内的小写字母、数字与下划线。', 400, 'ARTIFACT_CAS_KIND_INVALID');
    }
    return text;
}

/** 调用方给的上限不得突破环境变量配置的天花板。 */
function normalizeLimit(maxBytes) {
    const ceiling = maxObjectBytes();
    const parsed = Number.parseInt(maxBytes, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return Math.min(parsed, ceiling);
    return ceiling;
}

/** 保留期换算成到期时间；retentionDays<=0 表示不设保留期（expires_at 为 NULL）。 */
function computeExpiresAt(retentionDays) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return null;
    const capped = Math.min(days, MAX_RETENTION_DAYS);
    return getBeijingTimestamp(new Date(Date.now() + capped * 86400000));
}

/** 取较晚的到期时间：NULL 视为「未设置保留期」，不当作永久保留。 */
function laterExpiry(current, incoming) {
    if (!current) return incoming || null;
    if (!incoming) return current;
    return String(incoming) > String(current) ? incoming : current;
}

function normalizePutInput(params) {
    return {
        tenantId: Number(store.tenantSegment(params.tenantId)),
        ownerUserId: normalizeUserId(params.ownerUserId),
        mimeType: normalizeMimeType(params.mimeType),
        kind: normalizeKind(params.kind),
        expiresAt: computeExpiresAt(params.retentionDays),
        limit: normalizeLimit(params.maxBytes)
    };
}

/**
 * 对外可见的对象视图：刻意不含 storage_key。
 * storage_key 是服务端内部寻址信息，路由层若直接 JSON 化对象行会泄露磁盘布局（§7.1）。
 */
function toPublicObject(row) {
    if (!row) return null;
    const hasStorage = Boolean(String(row.storage_key || '').trim());
    return {
        id: row.id,
        ref: `${CAS_REF_PREFIX}${row.id}`,
        tenant_id: Number(row.tenant_id),
        owner_user_id: Number(row.owner_user_id),
        content_digest: String(row.content_digest || '').trim(),
        mime_type: row.mime_type,
        byte_size: Number(row.byte_size),
        kind: row.kind,
        ref_count: Number(row.ref_count),
        expires_at: row.expires_at || null,
        created_at: row.created_at || null,
        has_blob: hasStorage && row.kind !== KIND_EXPIRED
    };
}

async function loadObjectRow(objectId) {
    return await queryOne('SELECT * FROM agent_artifact_objects WHERE id = ?', [objectId]);
}

/**
 * 读授权（fail-closed）：
 * 1. 租户必须匹配；
 * 2. tenantScoped !== true 时还要求对象归属调用用户；
 * 3. tenantScoped:true 只允许调用方「已经完成 rendition/artifact 归属校验」后使用，
 *    否则等于把租户内任意对象开放给任意成员。
 * 两种未授权分支共用同一句提示，避免把错误原因当成对象存在性探针。
 */
function assertReadAccess(row, params) {
    const tenantId = Number.parseInt(params.tenantId, 10);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || Number(row.tenant_id) !== tenantId) {
        throw casError('无权读取该产物对象。', 403, 'ARTIFACT_CAS_FORBIDDEN');
    }
    if (params.tenantScoped === true) return;
    const userId = Number.parseInt(params.userId, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0 || Number(row.owner_user_id) !== userId) {
        throw casError('无权读取该产物对象。', 403, 'ARTIFACT_CAS_FORBIDDEN');
    }
}

/** 解析引用 → 取元数据行 → 授权 → 确认 blob 仍在。任何一步不通过都抛错，不返回空内容。 */
async function authorizeForRead(params) {
    const objectId = resolveObjectId(params);
    if (!objectId) throw casError('产物对象引用非法。', 400, 'ARTIFACT_CAS_REF_INVALID');
    const row = await loadObjectRow(objectId);
    if (!row) throw casError('产物对象不存在。', 404, 'ARTIFACT_CAS_NOT_FOUND');
    assertReadAccess(row, params);
    if (row.kind === KIND_EXPIRED || !String(row.storage_key || '').trim()) {
        throw casError('产物对象已过保留期，内容已按保留策略清理。', 410, 'ARTIFACT_CAS_EXPIRED');
    }
    return { row, object: toPublicObject(row) };
}

/** 查询对象元数据。租户不匹配、引用非法或对象不存在都返回 null。 */
async function statObject(params = {}) {
    const objectId = resolveObjectId(params);
    if (!objectId) return null;
    const tenantId = Number.parseInt(params.tenantId, 10);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) return null;
    const row = await queryOne('SELECT * FROM agent_artifact_objects WHERE id = ? AND tenant_id = ?', [objectId, tenantId]);
    return row ? toPublicObject(row) : null;
}

/** 打开对象内容流。发送前比对文件大小与登记值，不发送残缺文件。 */
async function openReadStream(params = {}) {
    const { row, object } = await authorizeForRead(params);
    const stat = await store.statStorageFile(row.storage_key);
    if (!stat.exists) throw casError('产物对象内容已不可用。', 410, 'ARTIFACT_CAS_CONTENT_MISSING');
    if (stat.size !== Number(row.byte_size)) {
        throw casError('产物对象文件大小与登记值不一致，已拒绝读取。', 500, 'ARTIFACT_CAS_SIZE_MISMATCH');
    }
    // 发送前完整重算摘要，避免“同长度文件被篡改”绕过仅元数据级校验。
    // CAS 文件应不可变；若发生外部篡改，宁可多一次顺序读取也不发送不可信字节。
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
        for await (const chunk of store.createStorageReadStream(row.storage_key)) {
            bytes += chunk.length;
            hash.update(chunk);
        }
    } catch (_) {
        throw casError('产物对象内容已不可用。', 410, 'ARTIFACT_CAS_CONTENT_MISSING');
    }
    const digest = hash.digest('hex');
    if (bytes !== Number(row.byte_size)) {
        throw casError('产物对象文件大小与登记值不一致，已拒绝读取。', 500, 'ARTIFACT_CAS_SIZE_MISMATCH');
    }
    if (digest !== String(row.content_digest || '').toLowerCase()) {
        throw casError('产物对象内容摘要与登记值不一致，已拒绝读取。', 500, 'ARTIFACT_CAS_DIGEST_MISMATCH');
    }
    return { stream: store.createStorageReadStream(row.storage_key), object };
}

/**
 * 读取整份对象内容，默认复算 sha256 与登记摘要比对。
 * 定位是 IR、图片等中小对象；大体积产物请走 openReadStream 以免整份进内存。
 */
async function readBuffer(params = {}) {
    const { row, object } = await authorizeForRead(params);
    const buffer = await store.readStorageFile(row.storage_key);
    if (buffer.length !== Number(row.byte_size)) {
        throw casError('产物对象文件大小与登记值不一致，已拒绝返回。', 500, 'ARTIFACT_CAS_SIZE_MISMATCH');
    }
    if (params.verifyDigest !== false) {
        const digest = crypto.createHash('sha256').update(buffer).digest('hex');
        if (digest !== object.content_digest) {
            throw casError('产物对象内容摘要与登记值不一致，已拒绝返回。', 500, 'ARTIFACT_CAS_DIGEST_MISMATCH');
        }
    }
    return { buffer, object };
}

function putResult(row, reused) {
    return {
        objectId: row.id,
        ref: `${CAS_REF_PREFIX}${row.id}`,
        contentDigest: String(row.content_digest || '').trim(),
        byteSize: Number(row.byte_size),
        mimeType: row.mime_type,
        reused
    };
}

/** 把内容送到最终位置：已有临时文件直接原子改名，否则按需生成临时文件。 */
async function materialize(source, storageKey) {
    const tempPath = source.tempPath || await source.writeTemp();
    await store.promoteTempToStorage(tempPath, storageKey);
}

/**
 * 命中同租户同摘要的既有行。
 * blob 仍完好 → 复用行与文件（reused=true），只按需延长保留期；
 * blob 已被保留期回收或被外部清理 → 用同摘要内容重新落盘并把行恢复为可读（reused=false，
 * 因为字节确实又写了一遍，调用方的去重计量不该把它算成命中）。
 */
async function reuseExistingObject(existing, context) {
    const { input, storageKey, byteSize, source } = context;
    const usable = existing.kind !== KIND_EXPIRED && Boolean(String(existing.storage_key || '').trim());
    const stat = usable ? await store.statStorageFile(existing.storage_key) : { exists: false, size: 0 };
    if (usable && stat.exists && stat.size === Number(existing.byte_size)) {
        await store.removeTempFile(source.tempPath);
        const merged = laterExpiry(existing.expires_at, input.expiresAt);
        if (merged === existing.expires_at) return putResult(existing, true);
        const extended = await queryOne(`
            UPDATE agent_artifact_objects
            SET expires_at = ?
            WHERE id = ?
            RETURNING *
        `, [merged, existing.id]);
        return putResult(extended || existing, true);
    }
    await materialize(source, storageKey);
    logger.warn({ objectId: existing.id, kind: existing.kind }, '[产物CAS] 元数据行存在但内容缺失，已按同摘要内容重新落盘');
    const restored = await queryOne(`
        UPDATE agent_artifact_objects
        SET storage_key = ?, kind = ?, byte_size = ?, expires_at = ?
        WHERE id = ?
        RETURNING *
    `, [storageKey, input.kind, byteSize, laterExpiry(existing.expires_at, input.expiresAt), existing.id]);
    return putResult(restored || existing, false);
}

/**
 * 登记对象：先落盘再写元数据行，保证元数据行绝不指向不存在的文件。
 * 反向的孤立文件是安全的：内容寻址下它会被下一次同摘要写入复用。
 */
async function commitObject(input, digest, byteSize, source) {
    const storageKey = store.buildStorageKey(input.tenantId, digest);
    const objectId = computeObjectId(input.tenantId, digest);
    const existing = await queryOne(
        'SELECT * FROM agent_artifact_objects WHERE tenant_id = ? AND content_digest = ?',
        [input.tenantId, digest]
    );
    if (existing) return await reuseExistingObject(existing, { input, storageKey, byteSize, source });
    await materialize(source, storageKey);
    const inserted = await queryOne(`
        INSERT INTO agent_artifact_objects
            (id, tenant_id, owner_user_id, content_digest, mime_type, byte_size, storage_key, kind, ref_count, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING *
    `, [
        objectId, input.tenantId, input.ownerUserId, digest, input.mimeType,
        byteSize, storageKey, input.kind, input.expiresAt, getBeijingTimestamp()
    ]);
    if (inserted) return putResult(inserted, false);
    // 并发写入同一摘要：另一路已经建好行，按复用返回，不再重复登记。
    const concurrent = await queryOne(
        'SELECT * FROM agent_artifact_objects WHERE tenant_id = ? AND content_digest = ?',
        [input.tenantId, digest]
    );
    if (!concurrent) throw casError('产物对象登记失败。', 500, 'ARTIFACT_CAS_REGISTER_FAILED');
    return putResult(concurrent, true);
}

/**
 * 写入整块内容。
 * 同租户同摘要幂等：命中既有行时不重复落盘，reused=true。
 * @returns {Promise<{objectId:string, ref:string, contentDigest:string, byteSize:number, mimeType:string, reused:boolean}>}
 */
async function putBuffer(params = {}) {
    const input = normalizePutInput(params);
    const buffer = params.buffer;
    if (!Buffer.isBuffer(buffer)) throw casError('写入产物对象需要 Buffer 内容。', 400, 'ARTIFACT_CAS_BUFFER_REQUIRED');
    if (!buffer.length) throw casError('产物对象内容为空，已拒绝写入。', 400, 'ARTIFACT_CAS_EMPTY');
    if (buffer.length > input.limit) {
        throw casError(`产物对象超过单文件大小上限 ${input.limit} 字节。`, 413, 'ARTIFACT_CAS_TOO_LARGE');
    }
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    // 去重命中时不需要临时文件，故把落盘动作延后成回调。
    return await commitObject(input, digest, buffer.length, {
        tempPath: null,
        writeTemp: async () => await store.writeBufferToTemp(buffer)
    });
}

/**
 * 流式写入：边写临时文件边算 sha256，超过 maxBytes 立即中止、删除临时文件并抛错。
 * maxBytes 默认取环境变量 PIVOT_ARTIFACT_MAX_BYTES，未配置时为 64MB。
 */
async function putStream(params = {}) {
    const input = normalizePutInput(params);
    const source = params.stream;
    if (!source || typeof source.pipe !== 'function') {
        throw casError('流式写入产物对象需要可读流。', 400, 'ARTIFACT_CAS_STREAM_REQUIRED');
    }
    const written = await store.writeStreamToTemp(source, input.limit);
    if (!written.byteSize) {
        await store.removeTempFile(written.tempPath);
        throw casError('产物对象内容为空，已拒绝写入。', 400, 'ARTIFACT_CAS_EMPTY');
    }
    return await commitObject(input, written.digest, written.byteSize, { tempPath: written.tempPath, writeTemp: null });
}

/**
 * 调整引用计数。
 * GREATEST 保证计数不会被减成负数 —— 负值会让回收条件永远不成立，对象将永久残留。
 * @returns {Promise<number>} 调整后的引用计数
 */
async function incrementRefCount(objectId, delta) {
    const id = resolveObjectId(objectId);
    if (!id) throw casError('产物对象引用非法。', 400, 'ARTIFACT_CAS_REF_INVALID');
    const step = Number.parseInt(delta, 10);
    if (!Number.isSafeInteger(step) || step === 0) {
        throw casError('引用计数增量必须是非零整数。', 400, 'ARTIFACT_CAS_REFCOUNT_INVALID');
    }
    const row = await queryOne(`
        UPDATE agent_artifact_objects
        SET ref_count = GREATEST(0, ref_count + CAST(? AS BIGINT))
        WHERE id = ?
        RETURNING ref_count
    `, [step, id]);
    if (!row) throw casError('产物对象不存在，无法调整引用计数。', 404, 'ARTIFACT_CAS_NOT_FOUND');
    return Number(row.ref_count);
}

/**
 * 无引用且保留期已过（或未设保留期）时回收对象。
 * 顺序是「先删元数据行再删文件」：反过来会短暂留下一个可读却指向空文件的元数据行。
 * 条件写进 DELETE 的 WHERE 里，避免「查完再删」之间被并发引用。
 */
async function deleteIfUnreferenced(objectId) {
    const id = resolveObjectId(objectId);
    if (!id) throw casError('产物对象引用非法。', 400, 'ARTIFACT_CAS_REF_INVALID');
    const rows = await query(`
        DELETE FROM agent_artifact_objects
        WHERE id = ? AND ref_count <= 0 AND (expires_at IS NULL OR expires_at <= ?)
        RETURNING storage_key
    `, [id, getBeijingTimestamp()]);
    if (!rows.length) return { deleted: false };
    try {
        // 文件缺失不算失败：元数据行已删，磁盘上本来也不该再有它。
        await store.removeStorageFile(rows[0].storage_key);
    } catch (error) {
        logger.warn({ objectId: id, err: error?.message }, '[产物CAS] 元数据行已删除但内容文件清理失败，需人工巡检');
    }
    return { deleted: true };
}

/**
 * 扫描到期对象：只删 blob 并把行标记为回收状态，保留元数据行以维持审计链（§7.3）。
 * 元数据行先落到不可读状态再删文件，任何时刻都不会出现「行说可读、文件已无」的窗口。
 */
async function expireOverdueObjects(options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 200, 1000));
    const now = getBeijingTimestamp();
    const candidates = await query(`
        SELECT id, storage_key
        FROM agent_artifact_objects
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND kind <> ? AND storage_key <> ''
        ORDER BY expires_at ASC
        LIMIT ?
    `, [now, KIND_EXPIRED, limit]);
    let expired = 0;
    for (const candidate of candidates) {
        const updated = await execute(`
            UPDATE agent_artifact_objects
            SET storage_key = '', kind = ?
            WHERE id = ? AND kind <> ?
        `, [KIND_EXPIRED, candidate.id, KIND_EXPIRED]);
        if (!updated) continue;
        expired += 1;
        try {
            await store.removeStorageFile(candidate.storage_key);
        } catch (error) {
            logger.warn({ objectId: candidate.id, err: error?.message }, '[产物CAS] 到期对象内容清理失败，需人工巡检');
        }
    }
    return { expired };
}

module.exports = {
    CAS_REF_PREFIX,
    KIND_EXPIRED,
    buildCasRef,
    casRoot,
    computeObjectId,
    deleteIfUnreferenced,
    expireOverdueObjects,
    incrementRefCount,
    maxObjectBytes,
    openReadStream,
    parseCasRef,
    putBuffer,
    putStream,
    readBuffer,
    statObject
};
