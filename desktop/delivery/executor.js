/**
 * desktop/delivery/executor.js
 * 桌面端受控交付执行器（落地方案 v1.2 §7.4、§7.6 写入流程、§7.7 安全边界、阶段 3.2 与 3.5）
 *
 * 单次交付流程：
 * 1. 用设备私钥签名服务端 nonce（先 challenge 再 claim）领取交付意图；
 * 2. 本地已写清单命中时直接回执，不重复落盘（幂等双侧保证，§7.4 第 5 条）；
 * 3. 双侧校验写入目录授权（本机授权表 + 服务端 target_dir_grant）与格式白名单；
 * 4. 单次体积上限与单日配额在桌面端再限一次（§7.7 第 5 条）；
 * 5. 凭一次性下载令牌拉取字节流，原子写入并校验摘要；
 * 6. 回执只上报文件名与末级目录提示，完整绝对路径只写本机已写清单。
 *
 * 所有外部依赖（HTTP 客户端、设备身份、清单、授权表、写入实现、目录选择框）均可注入。
 */
const os = require('os');
const path = require('path');
const { buildDeliveryFilename } = require('../../server/services/agent-path-safety');
const defaultIdentity = require('./device-identity');
const defaultManifest = require('./written-manifest');
const defaultGrants = require('./output-grants');
const { writeDeliveryFile } = require('./atomic-write');

const DEFAULT_POLL_INTERVAL_MS = 15000;
const MIN_POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 300000;
const DEFAULT_ATTEST_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_DAILY_QUOTA_BYTES = 512 * 1024 * 1024;
const MANIFEST_KEEP_DAYS = 90;

function executorError(message, code = 'DELIVERY_EXECUTOR_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(min, Math.min(parsed, max));
}

function envBytes(key, fallback) {
    const parsed = Number.parseInt(process.env[key], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function startOfDay(nowMs) {
    const date = new Date(nowMs);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function parseAllowedFormats(value) {
    if (Array.isArray(value)) return value.map(item => String(item).toLowerCase());
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return Array.isArray(parsed) ? parsed.map(item => String(item).toLowerCase()) : [];
    } catch (_) {
        return [];
    }
}

/**
 * 创建交付执行器。
 * @param {object} options 依赖与限额
 * @param {object} options.api 交付控制面客户端（desktop/delivery/api-client.js）
 * @param {object} options.identity 设备身份模块，默认使用 device-identity
 * @param {object} options.manifest 已写清单模块，默认使用 written-manifest
 * @param {object} options.grants 本机写入授权表，默认使用 output-grants
 * @param {Function} options.writeFile 原子写入实现，默认使用 atomic-write
 * @param {Function} options.chooseDirectory 目录选择回调（由主进程用系统对话框实现）
 */
function createDeliveryExecutor(options = {}) {
    const api = options.api;
    if (!api || typeof api.claim !== 'function') throw executorError('缺少交付控制面客户端。', 'DELIVERY_API_REQUIRED');
    const identity = options.identity || defaultIdentity;
    const manifest = options.manifest || defaultManifest;
    const grants = options.grants || defaultGrants;
    const writeFile = typeof options.writeFile === 'function' ? options.writeFile : writeDeliveryFile;
    const chooseDirectory = typeof options.chooseDirectory === 'function' ? options.chooseDirectory : null;
    const logger = options.logger || { warn() {}, error() {}, info() {} };
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const writeHooks = options.writeHooks && typeof options.writeHooks === 'object' ? options.writeHooks : {};
    const deviceName = String(options.deviceName || os.hostname() || '我的电脑').slice(0, 128);
    const limits = {
        pollIntervalMs: clampNumber(options.pollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
        attestIntervalMs: clampNumber(options.attestIntervalMs, 30000, 3600000, DEFAULT_ATTEST_INTERVAL_MS),
        maxBytes: Number(options.maxBytes) || envBytes('PIVOT_DELIVERY_MAX_BYTES', DEFAULT_MAX_BYTES),
        dailyQuotaBytes: Number(options.dailyQuotaBytes) || envBytes('PIVOT_DELIVERY_DAILY_QUOTA_BYTES', DEFAULT_DAILY_QUOTA_BYTES)
    };
    const state = {
        running: false,
        timer: null,
        intervalMs: limits.pollIntervalMs,
        registeredDeviceId: '',
        lastAttestAt: 0,
        lastRunAt: '',
        lastStatus: 'idle',
        lastError: '',
        deliveredCount: 0,
        failedCount: 0
    };

    /** 申请挑战值并用设备私钥签名，载荷与服务端约定的冒号拼接方式保持一致。 */
    async function signChallenge(purpose, deviceId, suffix = '') {
        const { nonce } = await api.challenge(purpose, deviceId);
        const payload = suffix ? `${purpose}:${nonce}:${deviceId}:${suffix}` : `${purpose}:${nonce}:${deviceId}`;
        return { nonce, signature: identity.signPayload(payload) };
    }

    async function signAck(deviceId, intentId, claimToken) {
        return signChallenge('ack', deviceId, `${intentId}:${claimToken}`);
    }

    /** 首次配对或进程重启后重新登记设备；服务端按设备标识幂等更新公钥与状态。 */
    async function ensureRegistered(deviceId) {
        if (state.registeredDeviceId === deviceId) return state.registeredDeviceId;
        const { nonce, signature } = await signChallenge('register', deviceId);
        await api.registerDevice({
            deviceId,
            deviceName,
            publicKeyPem: identity.getPublicKeyPem(),
            nonce,
            signature
        });
        state.registeredDeviceId = deviceId;
        state.lastAttestAt = now();
        return deviceId;
    }

    /** 周期心跳：让服务端确认设备在线且确实持有私钥（§7.7 第 2 个条件）。 */
    async function maybeAttest(deviceId) {
        if (now() - state.lastAttestAt < limits.attestIntervalMs) return false;
        const { nonce, signature } = await signChallenge('attest', deviceId);
        await api.attest(deviceId, { nonce, signature });
        state.lastAttestAt = now();
        return true;
    }

    /** 上报本次交付失败：服务端据 attempt_count 决定回到 pending 还是判定 failed。 */
    async function reportFailure(intentId, claimToken, failureCode, failureReason) {
        state.failedCount += 1;
        state.lastError = failureReason;
        try {
            const proof = await signAck(identity.getDeviceId(), intentId, claimToken);
            await api.fail(intentId, { claimToken, failureCode, failureReason, deviceId: identity.getDeviceId(), ...proof });
        } catch (error) {
            logger.warn(`上报交付失败结果未成功：${error && error.message ? error.message : '未知原因'}`);
        }
        return { status: 'failed', intentId, failureCode, failureReason };
    }

    /**
     * 摘要不一致：按 §7.4 第 3 条回报实际摘要，服务端据此判定 failed 并告警且不重试。
     * 服务端此时会返回 409，属于预期结果，因此这里吞掉异常。
     */
    async function reportDigestMismatch(intentId, claimToken, actualDigest) {
        state.failedCount += 1;
        state.lastError = '交付内容摘要与登记摘要不一致，已判定失败且不重试。';
        try {
            const deviceId = identity.getDeviceId();
            const proof = await signAck(deviceId, intentId, claimToken);
            await api.confirm(intentId, { claimToken, confirmedDigest: actualDigest, pathHint: '', overwritten: false, deviceId, ...proof });
        } catch (_) {}
        return { status: 'digest_mismatch', intentId };
    }

    /**
     * 落盘一次已领取的交付意图。
     * 四条件缺一即拒（用户意图 + 设备身份 + 目录授权 + 一次性令牌），本函数负责后两条的桌面侧校验。
     */
    async function deliverClaimed(deviceId, claim) {
        const intent = claim.intent || {};
        const claimToken = String(claim.claimToken || '');
        const rendition = claim.rendition || {};
        const format = String(rendition.format || '').toLowerCase();
        const expectedDigest = String(rendition.contentDigest || '').toLowerCase();
        const idempotencyKey = String(intent.idempotency_key || `intent:${intent.id}`);

        const written = manifest.getWritten(idempotencyKey);
        if (written && (!expectedDigest || String(written.digest || '') === expectedDigest)) {
            // 已写清单命中：直接回执，不重复落盘（§10.3 幂等性双侧用例）。
            const proof = await signAck(deviceId, intent.id, claimToken);
            await api.confirm(intent.id, {
                claimToken,
                deviceId,
                ...proof,
                confirmedDigest: written.digest,
                pathHint: written.pathHint || written.filename,
                overwritten: written.overwritten === true
            });
            return { status: 'reused', intentId: intent.id, filename: written.filename, pathHint: written.pathHint || '' };
        }

        const grantId = String(intent.target_dir_grant || (claim.grant && claim.grant.id) || '');
        const localGrant = grants.getLocalGrant(grantId);
        if (!localGrant) {
            return reportFailure(intent.id, claimToken, 'grant_not_authorized_locally', '本机没有该写入目录授权或授权已过期，已拒绝写入。');
        }
        const serverHint = String((claim.grant && claim.grant.pathHint) || '');
        if (serverHint && String(localGrant.pathHint || '') !== serverHint) {
            return reportFailure(intent.id, claimToken, 'grant_hint_mismatch', '服务端与本机记录的授权目录提示不一致，已拒绝写入。');
        }
        const allowedFormats = parseAllowedFormats(localGrant.allowedFormats);
        if (allowedFormats.length && !allowedFormats.includes(format)) {
            return reportFailure(intent.id, claimToken, 'format_not_allowed', '该授权目录不允许写入当前文档格式，已拒绝写入。');
        }

        const grantMaxBytes = Number(claim.grant && claim.grant.maxBytes) || 0;
        const maxBytes = grantMaxBytes ? Math.min(limits.maxBytes, grantMaxBytes) : limits.maxBytes;
        const byteSize = Number(rendition.byteSize) || 0;
        if (byteSize && byteSize > maxBytes) {
            return reportFailure(intent.id, claimToken, 'size_limit_exceeded', '交付内容超过本机单次写入体积上限，已拒绝写入。');
        }
        const usedToday = manifest.sumBytesWrittenSince(startOfDay(now()));
        if (limits.dailyQuotaBytes && usedToday + byteSize > limits.dailyQuotaBytes) {
            return reportFailure(intent.id, claimToken, 'daily_quota_exceeded', '本机今日交付写入量已达配额上限，已拒绝写入。');
        }

        const filename = buildDeliveryFilename(claim.targetFilename || intent.target_filename || `产物-${rendition.id}`, format);
        let download = null;
        try {
            const proof = await signChallenge('download', deviceId, `${rendition.id}:${claim.downloadToken}`);
            download = await api.downloadRendition(rendition.id, claim.downloadToken, deviceId, proof);
        } catch (error) {
            return reportFailure(intent.id, claimToken, 'download_failed', `拉取交付字节流失败：${error && error.message ? error.message : '未知原因'}`);
        }
        try {
            const result = await writeFile({
                directory: localGrant.directory,
                filename,
                expectedDigest,
                source: download.body,
                allowOverwrite: claim.allowOverwrite === true,
                maxBytes,
                hooks: writeHooks
            });
            // 完整绝对路径只写本机清单；回执与控制面只拿到文件名与末级目录提示。
            const pathHint = `${path.basename(localGrant.directory)}/${result.filename}`.slice(0, 255);
            manifest.recordWritten({
                key: idempotencyKey,
                targetPath: result.targetPath,
                filename: result.filename,
                pathHint,
                digest: result.digest,
                bytes: result.bytes,
                intentId: intent.id,
                renditionId: rendition.id,
                overwritten: result.overwritten
            });
            const proof = await signAck(deviceId, intent.id, claimToken);
            await api.confirm(intent.id, {
                claimToken,
                deviceId,
                ...proof,
                confirmedDigest: result.digest,
                pathHint,
                overwritten: result.overwritten === true
            });
            state.deliveredCount += 1;
            state.lastError = '';
            return {
                status: 'delivered',
                intentId: intent.id,
                filename: result.filename,
                bytes: result.bytes,
                overwritten: result.overwritten === true,
                pathHint
            };
        } catch (error) {
            if (error && error.code === 'DELIVERY_DIGEST_MISMATCH') {
                return reportDigestMismatch(intent.id, claimToken, String(error.actualDigest || ''));
            }
            const failureCode = String((error && error.code) || 'device_write_failed').slice(0, 64);
            return reportFailure(intent.id, claimToken, failureCode, error && error.message ? error.message : '本机写入失败。');
        }
    }

    /** 轮询一次：领取并交付至多一个意图，无待办时返回 idle。 */
    async function runOnce() {
        const deviceId = identity.getDeviceId();
        await ensureRegistered(deviceId);
        try {
            await maybeAttest(deviceId);
        } catch (error) {
            logger.warn(`设备心跳失败：${error && error.message ? error.message : '未知原因'}`);
        }
        const { nonce, signature } = await signChallenge('claim', deviceId);
        const claim = await api.claim({ deviceId, nonce, signature, workerId: deviceId });
        state.lastRunAt = new Date(now()).toISOString();
        const status = String(claim.status || 'idle');
        if (status !== 'claimed' || !claim.intent) {
            state.lastStatus = status;
            return { status };
        }
        const result = await deliverClaimed(deviceId, claim);
        state.lastStatus = result.status;
        return result;
    }

    /**
     * 授权一个写入目录：目录必须由用户在系统对话框中显式选择，
     * 校验通过后用设备私钥签名登记到服务端，本机只保存「授权 id → 绝对路径」映射。
     */
    async function authorizeOutputDirectory(input = {}) {
        if (!chooseDirectory) throw executorError('当前环境无法打开目录选择对话框。', 'DELIVERY_DIR_PICKER_UNAVAILABLE');
        const deviceId = identity.getDeviceId();
        const chosen = await chooseDirectory();
        if (!chosen || chosen.canceled || !chosen.directory) return { canceled: true };
        const validated = grants.validateOutputDirectory(chosen.directory);
        await ensureRegistered(deviceId);
        const { nonce, signature } = await signChallenge('grant', deviceId, validated.pathHint);
        const grant = await api.registerOutputGrant(deviceId, {
            pathHint: validated.pathHint,
            allowedFormats: Array.isArray(input.allowedFormats) ? input.allowedFormats : undefined,
            expiresInDays: input.expiresInDays,
            nonce,
            signature
        });
        if (!grant || !grant.id) throw executorError('服务端未返回写入授权标识。', 'DELIVERY_GRANT_ID_MISSING');
        const saved = grants.saveLocalGrant({
            grantId: grant.id,
            deviceId,
            directory: validated.directory,
            pathHint: validated.pathHint,
            allowedFormats: parseAllowedFormats(grant.allowed_formats),
            expiresAt: String(grant.expires_at || '')
        });
        return {
            canceled: false,
            grant: {
                grantId: saved.grantId,
                pathHint: saved.pathHint,
                directoryName: path.basename(saved.directory),
                allowedFormats: saved.allowedFormats,
                expiresAt: saved.expiresAt
            }
        };
    }

    /** 撤销写入授权：服务端撤销失败也要移除本机映射，保证 fail-closed。 */
    async function revokeOutputDirectory(grantId) {
        const key = String(grantId || '').trim();
        if (!key) throw executorError('缺少要撤销的写入授权标识。', 'DELIVERY_GRANT_ID_REQUIRED');
        let serverRevoked = false;
        try {
            await api.revokeOutputGrant(key);
            serverRevoked = true;
        } catch (error) {
            logger.warn(`服务端撤销写入授权未成功，仍将移除本机授权：${error && error.message ? error.message : '未知原因'}`);
        }
        return { grantId: key, serverRevoked, localRemoved: grants.removeLocalGrant(key) };
    }

    function scheduleNext(delayMs) {
        if (!state.running) return;
        state.timer = setTimeout(() => { tick(); }, Math.max(Number(delayMs) || 0, 0));
        if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
    }

    async function tick() {
        if (!state.running) return;
        try {
            await runOnce();
        } catch (error) {
            state.lastStatus = 'error';
            state.lastError = error && error.message ? error.message : '交付轮询失败。';
            logger.error(`交付轮询执行失败：${state.lastError}`);
        }
        scheduleNext(state.intervalMs);
    }

    function start(input = {}) {
        if (state.running) return getStatus();
        // 启动前先取一次设备身份：safeStorage 不可用时直接抛出中文原因，不进入轮询。
        identity.getDeviceId();
        state.intervalMs = clampNumber(input.intervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, limits.pollIntervalMs);
        state.running = true;
        state.lastError = '';
        state.lastStatus = 'starting';
        try { manifest.pruneOlderThan(MANIFEST_KEEP_DAYS); } catch (_) {}
        try { grants.pruneExpiredGrants(); } catch (_) {}
        scheduleNext(0);
        return getStatus();
    }

    function stop() {
        state.running = false;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        state.lastStatus = 'stopped';
        return getStatus();
    }

    function safeCall(callback, fallback) {
        try {
            return callback();
        } catch (_) {
            return fallback;
        }
    }

    function getStatus() {
        const identityStatus = typeof identity.getIdentityStatus === 'function'
            ? identity.getIdentityStatus()
            : { available: false, reason: '设备身份模块不可用。' };
        return {
            available: identityStatus.available === true,
            reason: identityStatus.reason || '',
            deviceId: identityStatus.deviceId || '',
            deviceName,
            keyType: identityStatus.keyType || '',
            keyFingerprint: identityStatus.keyFingerprint || '',
            registered: Boolean(state.registeredDeviceId),
            running: state.running,
            intervalMs: state.intervalMs,
            lastRunAt: state.lastRunAt,
            lastStatus: state.lastStatus,
            lastError: state.lastError,
            deliveredCount: state.deliveredCount,
            failedCount: state.failedCount,
            limits: {
                maxBytes: limits.maxBytes,
                dailyQuotaBytes: limits.dailyQuotaBytes,
                attestIntervalMs: limits.attestIntervalMs
            },
            usedTodayBytes: safeCall(() => manifest.sumBytesWrittenSince(startOfDay(now())), 0),
            grants: safeCall(() => grants.listLocalGrants(), []),
            recentWrites: safeCall(() => manifest.listWritten(10), [])
        };
    }

    return {
        authorizeOutputDirectory,
        ensureRegistered,
        getStatus,
        revokeOutputDirectory,
        runOnce,
        start,
        stop
    };
}

module.exports = {
    createDeliveryExecutor,
    parseAllowedFormats,
    startOfDay
};
