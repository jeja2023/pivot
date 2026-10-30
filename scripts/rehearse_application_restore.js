'use strict';
/* global Blob, FormData */

// 只针对随机生成的测试 schema、测试服务和临时目录；不接受外部恢复目标。
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const { PDFDocument } = require('pdf-lib');
const { createBackupBundle, verifyBackupBundle } = require('../server/services/offline-backup-bundle');
const { postgresCommandEnv } = require('../server/services/postgres-command-env');
const run = promisify(execFile);

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function main() {
    const url = String(process.env.TEST_DATABASE_URL || '');
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('演练只接受本机 TEST_DATABASE_URL。');
    const schema = `pivot_restore_${crypto.randomBytes(8).toString('hex')}`;
    if (!/^pivot_restore_[a-f0-9]{16}$/.test(schema)) throw new Error('隔离 schema 校验失败。');
    const tempBase = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(tempBase, 'pivot-application-restore-'));
    const data = path.join(root, 'data');
    const uploads = path.join(root, 'uploads');
    const cas = path.join(data, 'agent-artifact-objects');
    const documents = path.join(root, 'documents');
    const analysis = path.join(root, 'analysis');
    const blobs = path.join(root, 'agent-blobs');
    const packs = path.join(root, 'agent-runtime-packs');
    const skills = path.join(data, 'agent-skills');
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const bin = process.env.PIVOT_RESTORE_PG_BIN || '';
    const executable = name => bin ? path.join(bin, process.platform === 'win32' ? `${name}.exe` : name) : name;
    const env = { ...process.env, DATABASE_URL: url, PG_TEST_SCHEMA: schema, PG_IDLE_TIMEOUT_MS: '100', PIVOT_TEST_PG_SYNC: 'true',
        DATA_DIR: data, PIVOT_ARTIFACT_CAS_DIR: cas, PIVOT_UPLOAD_DIR: uploads, UPLOAD_DIR: uploads,
        PIVOT_DOCUMENT_PROCESSING_DIR: documents, PIVOT_ANALYSIS_DIR: analysis, AGENT_BLOB_DIR: blobs, PIVOT_RUNTIME_PACK_ROOT: packs,
        LOG_DIR: path.join(root, 'logs'),
        PORT: String(port), DEFAULT_ADMIN_PASSWORD: 'RestoreTest123!', JWT_SECRET: 'restore-test-jwt-secret-012345678901234567890123',
        DATA_ENCRYPTION_KEY: 'restore-test-data-secret-012345678901234567890123', TZ: 'Asia/Shanghai', PG_TIMEZONE: 'Asia/Shanghai' };
    const client = new Client({ connectionString: url });
    let child;
    let connected = false;
    const runScript = async args => run(process.execPath, args, { env, cwd: path.resolve(__dirname, '..'), windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    async function stop() {
        if (!child) return;
        const running = child; child = null;
        if (running.exitCode !== null) return;
        const exited = new Promise(resolve => running.once('exit', resolve));
        running.kill();
        let timer;
        try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试服务未停止。')), 15000); })]); }
        finally { clearTimeout(timer); }
    }
    async function start() {
        child = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], { env, cwd: path.resolve(__dirname, '..'), stdio: 'ignore', windowsHide: true });
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error('测试服务启动失败。');
            try { if ((await fetch(`${base}/api/health`)).ok) return; } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('测试服务启动超时。');
    }
    let cookie = '';
    async function request(route, options = {}) {
        const headers = { ...(options.headers || {}), ...(cookie ? { cookie } : {}) };
        const csrf = cookie.match(/(?:^|;\s*)pivot_csrf_token=([^;]+)/)?.[1];
        if (csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
        const response = await fetch(`${base}${route}`, { ...options, headers });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies.map(item => item.split(';')[0]).join('; ');
        if (!response.ok) throw new Error(`${route} 返回 ${response.status}`);
        return response;
    }
    const json = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    try {
        await client.connect(); connected = true;
        await runScript([path.join(__dirname, 'setup_pg_test_db.js')]);
        for (const directory of [cas, uploads, documents, analysis, blobs, packs, skills]) await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(cas, 'restore-fixture.txt'), '隔离产物恢复样本');
        await fs.writeFile(path.join(blobs, 'restore-fixture.txt'), '隔离大对象恢复样本');
        await fs.writeFile(path.join(packs, 'restore-fixture.txt'), '隔离运行包恢复样本');
        await fs.writeFile(path.join(skills, 'restore-fixture.txt'), '隔离技能恢复样本');
        await start();
        await request('/api/auth/login', json({ username: 'admin', password: env.DEFAULT_ADMIN_PASSWORD }));
        const session = await (await request('/api/sessions', json({ title: '恢复演练会话' }))).json();
        const settings = await (await request('/api/admin/settings/runtime', { ...json({ max_attachments_per_message: 4 }), method: 'PUT' })).json();
        if (Number(settings.runtimeConfig?.values?.maxAttachmentsPerMessage) !== 4) throw new Error('运行配置写入未确认。');
        const ocrSettings = await (await request('/api/apps/ocr/settings', { ...json({ serviceUrl: 'http://127.0.0.1:19191' }), method: 'PUT' })).json();
        if (ocrSettings.settings?.serviceUrl !== 'http://127.0.0.1:19191') throw new Error('OCR 配置写入未确认。');
        const form = new FormData(); form.append('file', new Blob(['隔离上传恢复样本'], { type: 'text/plain' }), 'restore.txt');
        const attachment = await (await request(`/api/upload?sessionId=${encodeURIComponent(session.id)}`, { method: 'POST', body: form })).json();
        const datasetForm = new FormData();
        datasetForm.append('file', new Blob(['区域,金额\n华东,123\n'], { type: 'text/csv' }), 'restore.csv');
        const dataset = (await (await request('/api/apps/data-analysis/datasets', { method: 'POST', body: datasetForm })).json()).dataset;
        const pdf = await PDFDocument.create(); pdf.addPage([300, 200]);
        const pdfBytes = await pdf.save();
        const pdfForm = new FormData();
        pdfForm.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'one.pdf');
        pdfForm.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'two.pdf');
        pdfForm.append('operation', 'merge');
        const pdfJob = (await (await request('/api/apps/pdf-tools/jobs', { method: 'POST', body: pdfForm })).json()).job;
        let pdfDetail;
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            pdfDetail = await (await request(`/api/apps/pdf-tools/jobs/${pdfJob.id}`)).json();
            if (pdfDetail.job.status === 'succeeded') break;
            if (['failed', 'cancelled'].includes(pdfDetail.job.status)) throw new Error('PDF 测试任务未成功。');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (pdfDetail?.job?.status !== 'succeeded' || !pdfDetail.outputs?.length) throw new Error('PDF 测试任务未完成。');
        const outputId = pdfDetail.outputs[0].id;
        await stop();
        const backup = path.join(root, 'backup');
        await createBackupBundle({ output: backup, maintenanceConfirmed: true, env, dumpDatabase: destination => run(executable('pg_dump'),
            ['--no-password', '--format=custom', '--schema', schema, '--file', destination], { env: postgresCommandEnv(url), windowsHide: true, timeout: 120000 }) });
        await verifyBackupBundle(backup);
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await run(executable('pg_restore'), ['--dbname', decodeURIComponent(parsed.pathname.slice(1)), '--no-password', '--no-owner', '--no-privileges', '--exit-on-error', path.join(backup, 'database.dump')],
            { env: postgresCommandEnv(url), windowsHide: true, timeout: 120000 });
        for (const [name, directory] of Object.entries({ uploads, cas, 'document-processing': documents, analysis, 'agent-blobs': blobs, 'agent-runtime-packs': packs, 'agent-skills': skills })) {
            if (!directory.startsWith(root + path.sep)) throw new Error('恢复目录越过隔离边界。');
            await fs.rm(directory, { recursive: true, force: true });
            await fs.cp(path.join(backup, name), directory, { recursive: true });
        }
        cookie = ''; await start();
        await request('/api/auth/login', json({ username: 'admin', password: env.DEFAULT_ADMIN_PASSWORD }));
        const restored = await (await request(`/api/sessions/${encodeURIComponent(session.id)}`)).json();
        if (restored.session?.title !== '恢复演练会话' && restored.title !== '恢复演练会话') throw new Error('恢复后的会话不一致。');
        if ((await (await request(attachment.url)).text()) !== '隔离上传恢复样本') throw new Error('恢复后的附件内容不一致。');
        const restoredSettings = await (await request('/api/settings')).json();
        if (Number(restoredSettings.runtimeConfig?.values?.maxAttachmentsPerMessage) !== 4) throw new Error('恢复后的运行配置不一致。');
        const restoredOcr = await (await request('/api/apps/ocr/settings')).json();
        if (restoredOcr.settings?.serviceUrl !== 'http://127.0.0.1:19191') throw new Error('恢复后的 OCR 配置不一致。');
        if ((await fs.readFile(path.join(cas, 'restore-fixture.txt'), 'utf8')) !== '隔离产物恢复样本') throw new Error('恢复后的产物内容不一致。');
        const restoredDataset = (await (await request(`/api/apps/data-analysis/datasets/${dataset.id}`)).json()).dataset;
        if (restoredDataset.rowCount !== 1 || !JSON.stringify(restoredDataset.previewRows).includes('华东')) throw new Error('恢复后的分析数据不一致。');
        const restoredPdf = await (await request(`/api/apps/pdf-tools/outputs/${outputId}/download`)).arrayBuffer();
        if ((await PDFDocument.load(restoredPdf)).getPageCount() !== 2) throw new Error('恢复后的 PDF 输出不一致。');
        for (const [directory, text] of [[blobs, '隔离大对象恢复样本'], [packs, '隔离运行包恢复样本'], [skills, '隔离技能恢复样本']]) {
            if ((await fs.readFile(path.join(directory, 'restore-fixture.txt'), 'utf8')) !== text) throw new Error('恢复后的 Agent 文件不一致。');
        }
        console.log('隔离应用恢复通过：登录、会话、附件、配置、分析数据、PDF 输出及 Agent 文件均已核对。');
    } finally {
        await stop();
        if (connected) { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); }
        if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('pivot-application-restore-')) throw new Error('临时目录校验失败。');
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

if (require.main === module) main().catch(error => { console.error(`隔离应用恢复演练失败：${error.message}`); process.exitCode = 1; });
module.exports = { main };
