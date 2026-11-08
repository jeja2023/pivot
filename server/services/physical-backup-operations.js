'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const physical = require('./physical-backup');
const common = require('./common-recovery');
const sealed = require('./backup-sealed-files');
const { canonicalHash } = require('./data-analysis/bi/canonical');
const DAY = 86400000;
const executeChild = promisify(execFile);

async function confirmSecurity(config) {
    // 使用独立进程与连接池，在获取全局排他屏障前完成；管道的 SQL 写入绝不能在当前会话的屏障上等待。

    const modulePath = path.resolve(__dirname, 'data-analysis/bi/security-journal.js'), poolPath = path.resolve(__dirname, '../db/pg-connection.js');
    const script = `require(${JSON.stringify(modulePath)}).flush({force:true,full:true}).then(value=>{if(value.mode!=='ready')throw new Error('安全清单与独立确认尚未完成');}).catch(error=>{process.stderr.write(error.message);process.exitCode=1;}).finally(()=>require(${JSON.stringify(poolPath)}).closePgPool());`;
    await executeChild(process.execPath, ['-e', script], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ...config.environment, DATABASE_URL: config.operatorConnection, PG_TEST_SCHEMA: config.schema,
            DATA_ANALYSIS_MODEL_ENABLED: 'true', PG_IDLE_TIMEOUT_MS: '100' } });
    return { confirmed: true };
}

async function catalog(config, kind) {
    const directory = path.join(config.backupRoot, kind === 'base' ? 'bases' : 'points');
    let names;
    try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const manifests = [];
    for (const name of names) {
        if (name.startsWith('.pending-') || name.startsWith('.json-')) continue;
        if (!new RegExp(`^${kind}_[a-f0-9-]{36}\\.seal$`).test(name)) throw new Error('独立备份目录包含未识别的清单文件。');
        const id = name.slice(0, -5), manifest = await physical.readManifest(config, id);
        if (manifest.id !== id || manifest.clusterId !== config.clusterId || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('独立备份目录清单身份或时间无效。');
        manifests.push(manifest);
    }
    return manifests.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
function retentionPlan(points, bases, now = Date.now()) {
    const retainPoints = new Set(), daily = new Set();
    for (const point of points) {
        const age = now - Date.parse(point.createdAt), day = point.createdAt.slice(0, 10);
        if (point.status !== 'verified') throw new Error('未完成恢复点不得进入保留目录。');
        if (age <= 7 * DAY || age <= 30 * DAY && !daily.has(day) || point === points[0]) retainPoints.add(point.id);
        daily.add(day);
    }
    const retainBases = new Set(points.filter(point => retainPoints.has(point.id)).map(point => point.baseId));
    for (const base of bases) if (now - Date.parse(base.createdAt) <= 30 * DAY || base === bases[0]) retainBases.add(base.id);
    if ([...retainBases].some(id => !bases.some(base => base.id === id))) throw new Error('保留恢复点引用的基础备份缺失，停止清理。');
    return { retainPoints, retainBases, expiredPoints: points.filter(point => !retainPoints.has(point.id)), expiredBases: bases.filter(base => !retainBases.has(base.id)) };
}
async function removeOwnedFile(root, file) {
    const target = path.resolve(file);
    if (!sealed.inside(root, target) || root === target || await fs.realpath(target) !== target) throw new Error('备份保留清理越过独立目录。');
    await sealed.regularFile(target); await fs.unlink(target); await sealed.syncDirectory(path.dirname(target));
}
async function applyRetention(config, { now = Date.now(), client } = {}) {
    if (!client) throw new Error('保留清理必须持有独立运维串行会话。');
    const points = await catalog(config, 'point'), bases = await catalog(config, 'base'), plan = retentionPlan(points, bases, now);
    const objectDigests = new Set(), escrowDigests = new Set(), retainedWal = new Set();
    for (const base of bases.filter(item => plan.retainBases.has(item.id))) {
        await physical.verifyBase(config, base.id);
        base.files.forEach(item => objectDigests.add(item.sha256));
    }
    for (const point of points.filter(item => plan.retainPoints.has(item.id))) {
        await common.verifyPoint(config, point.id);
        point.files.forEach(item => objectDigests.add(item.sha256)); point.escrow.forEach(item => escrowDigests.add(item.sha256)); point.wal.forEach(name => retainedWal.add(name));
    }
    // 在验证所有保留链路/对象和安全锚点前不得开始删除；时间点与基础密封为不可变，移除即表示恢复点过期。

    for (const point of plan.expiredPoints) {
        await client.query("UPDATE analysis_recovery_points SET status='expired' WHERE id=$1 AND status='verified'", [point.id]);
        await removeOwnedFile(config.backupRoot, physical.manifestPath(config, point.id));
        await client.query("DELETE FROM analysis_object_references WHERE reference_kind='backup' AND reference_id=$1", [point.id]);
    }
    for (const base of plan.expiredBases) await removeOwnedFile(config.backupRoot, physical.manifestPath(config, base.id));
    let deletedObjects = 0, deletedWal = 0;
    for (const [root, retained] of [[config.backupRoot, objectDigests], [config.escrowRoot, escrowDigests]]) {
        const directory = path.join(root, 'objects');
        let names; try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.seal$/.test(name)) continue;
            const file = path.join(directory, name), stat = await sealed.regularFile(file);
            // 完整备份与检查点过程受限于孤儿宽限期；其他进行中的发布流程不会丢失预复制的数据。

            if (!retained.has(name.slice(0, -5)) && now - Number(stat.mtimeMs) > DAY) { await removeOwnedFile(root, file); deletedObjects++; }
        }
    }
    const walDirectory = path.join(config.backupRoot, 'wal', config.clusterId);
    let names; try { names = await fs.readdir(walDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    // 七天内的新归档即使尚未被最新的五分钟时间点索引也予保留；较旧的每日恢复点会固定基础与目标之间的每个段。


    for (const name of names) if (/^[0-9A-F]{24}\.seal$/.test(name)) {
        const file = path.join(walDirectory, name), stat = await sealed.regularFile(file);
        if (!retainedWal.has(name.slice(0, -5)) && now - Number(stat.mtimeMs) > 7 * DAY) { await removeOwnedFile(config.backupRoot, file); deletedWal++; }
    }
    return { expiredPoints: plan.expiredPoints.length, expiredBases: plan.expiredBases.length, deletedObjects, deletedWal, retainedPoints: plan.retainPoints.size, retainedBases: plan.retainBases.size };
}
async function confirmPoint(config, id, client) {
    await require('../repositories/analysis-common-recovery').securityHead(client);
    const { point } = await common.verifyPoint(config, id);
    await require('../repositories/analysis-common-recovery').verified(client, { ...point, digest: canonicalHash(point) });
    return { id, verified: true };
}
async function tick(config, { prune = false } = {}) {
    const client = await physical.connect(config);
    let locked = false;
    try {
        locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:physical-backup-operations'),0) AS acquired")).rows[0].acquired;
        if (!locked) return { busy: true };
        const facts = await physical.preflight(client, config);
        await confirmSecurity(config);
        let bases = await catalog(config, 'base'), points = await catalog(config, 'point');
        let full = null, point = null;
        if (!bases.length || bases[0].facts.timeline !== facts.timeline || Date.now() - Date.parse(bases[0].createdAt) >= DAY) { full = await physical.createBase(config); bases = await catalog(config, 'base'); }
        if (!points.length || Date.now() - Date.parse(points[0].createdAt) >= 300000 || full) {
            point = await common.createPoint(config, bases[0].id); points = await catalog(config, 'point');
        } else await confirmPoint(config, points[0].id, client);
        const latest = points[0], ageSeconds = latest ? Math.max(0, (Date.now() - Date.parse(latest.createdAt)) / 1000) : null;
        const retention = prune ? await applyRetention(config, { client }) : null;
        return { full, point, retention, latestPoint: latest?.id, recoveryAgeSeconds: ageSeconds, rpoTargetSeconds: 900, healthy: ageSeconds !== null && ageSeconds <= 900, productionCertified: false };
    } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('pivot:physical-backup-operations'),0)").catch(() => {});
        await client.end();
    }
}

module.exports = { catalog, retentionPlan, confirmPoint, confirmSecurity, tick };
