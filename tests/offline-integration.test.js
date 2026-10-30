'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const { backupPaths, createBackupBundle, verifyBackupBundle } = require('../server/services/offline-backup-bundle');
const { mcpOutboundOptions } = require('../server/services/mcp-managed-outbound');
const { sanitizeSvg } = require('../server/services/document-rendering/image-renderer');
const { renderDocumentIr } = require('../server/services/document-rendering');
const { auditReportIr } = require('../server/services/tool-result-artifacts');
const { previewSkillSource } = require('../server/services/agent-skill-authoring');
const { main: exportOfflineTools, renderComposeForToolsImage } = require('../scripts/offline_tools_release');

test('离线包使用指定镜像并拒绝注入或不匹配的 Compose 配置', () => {
    const compose = 'services:\n  offline-tools:\n    image: pivot-offline-tools:1.0.0\n';
    assert.match(renderComposeForToolsImage(compose, 'pivot-offline-tools:review-20261029'), /image: pivot-offline-tools:review-20261029/);
    assert.throws(() => renderComposeForToolsImage(compose, 'bad:tag\n    privileged: true'), /镜像/);
    assert.throws(() => renderComposeForToolsImage('services: {}', 'pivot-offline-tools:review-20261029'), /Compose/);
});

test('无效镜像标签在创建离线包之前被拒绝', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-offline-export-test-'));
    const output = path.join(root, 'bundle');
    try {
        await assert.rejects(exportOfflineTools(['--export', output, '--tools-image=bad:tag\n    privileged: true']), /镜像/);
        await assert.rejects(fs.access(output), error => error.code === 'ENOENT');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('技能不得把能力登记裸名误认为连接器执行入口', () => {
    const markdown = '---\nid: read-source\nname: read-source\nversion: 1.0.0\nschemaVersion: 1\ncapabilities: [filesystem.read_workspace]\ntools: [workspace.read]\ninputs: {}\noutputs: {}\n---\n只读授权源码。';
    assert.equal(previewSkillSource(markdown).valid, false);
    assert.equal(previewSkillSource(markdown.replace('tools: [workspace.read]', 'tools: [mcp.0.workspace.read]')).valid, true);
});

test('全局连接委托只放行数据库核验过的固定端点并遵守任务网络策略', async () => {
    const lookup = dns.lookup;
    dns.lookup = async () => [{ address: '10.20.30.40', family: 4 }];
    const server = { id: 42, base_url: 'http://offline-tools:8501/mcp' };
    const user = { id: 2, role: 'user' };
    try {
        const approved = async () => ({ ...server, user_id: null, status: 'active' });
        await assert.rejects(mcpOutboundOptions(server, user, { requireNetworkPolicy: true }, approved), /网络白名单/);
        const guard = await mcpOutboundOptions(server, user, {}, approved);
        await guard.assertUrl(server.base_url);
        await assert.rejects(guard.assertUrl('http://offline-tools:8501/other'), /登记端点/);
        const denied = await mcpOutboundOptions(server, user, {}, async () => ({ ...server, user_id: 2, status: 'active' }));
        await assert.rejects(denied.assertUrl(server.base_url));
        const revoked = await mcpOutboundOptions(server, user, {}, async () => null);
        await assert.rejects(revoked.assertUrl(server.base_url));
        const restricted = await mcpOutboundOptions(server, user, { networkPolicy: { allowed_origins: ['http://other:8501'], allowed_ports: [8501] } }, approved);
        await assert.rejects(restricted.assertUrl(server.base_url), /白名单/);
        const metadata = { id: 42, base_url: 'http://169.254.169.254/mcp' };
        const sensitive = await mcpOutboundOptions(metadata, user, {}, async () => ({ ...metadata, user_id: null, status: 'active' }));
        await assert.rejects(sensitive.assertUrl(metadata.base_url));
    } finally { dns.lookup = lookup; }
});

test('备份解析真实配置并校验完整包，拒绝未确认维护与篡改文件', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-backup-test-'));
    const env = { DATA_DIR: path.join(root, 'data'), PIVOT_UPLOAD_DIR: path.join(root, 'uploads') };
    const sources = backupPaths(env, root);
    try {
        for (const source of Object.values(sources)) { await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'example.txt'), '恢复凭据'); }
        const options = { output: path.join(root, 'backup'), env, maintenanceConfirmed: true, dumpDatabase: target => fs.writeFile(target, '隔离测试数据库转储') };
        await assert.rejects(createBackupBundle({ ...options, maintenanceConfirmed: false }), /维护窗口/);
        await createBackupBundle(options);
        const manifest = await verifyBackupBundle(options.output);
        assert.equal(manifest.version, 2);
        assert.equal(manifest.files.length, 8);
        assert.equal(manifest.files.some(item => item.path === 'cas/example.txt'), true);
        for (const name of ['document-processing', 'analysis', 'agent-blobs', 'agent-runtime-packs', 'agent-skills']) {
            assert.equal(manifest.files.some(item => item.path === `${name}/example.txt`), true);
        }
        await fs.writeFile(path.join(options.output, 'uploads/example.txt'), '已篡改');
        await assert.rejects(verifyBackupBundle(options.output), /校验失败/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('备份明确记录缺失目录，排除临时文件并兼容旧清单', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-backup-scope-'));
    const env = { DATA_DIR: path.join(root, 'data'), PIVOT_UPLOAD_DIR: path.join(root, 'uploads') };
    const sources = backupPaths(env, root);
    try {
        await fs.mkdir(sources.cas, { recursive: true });
        await fs.mkdir(sources.uploads, { recursive: true });
        await fs.mkdir(path.join(sources.analysis, 'tmp'), { recursive: true });
        await fs.writeFile(path.join(sources.analysis, 'tmp', 'temporary.txt'), '不纳入备份');
        await fs.mkdir(path.join(sources.analysis, 'datasets'), { recursive: true });
        await fs.writeFile(path.join(sources.analysis, 'datasets', 'preserved.bin'), '分析数据');
        const output = path.join(root, 'backup');
        const manifest = await createBackupBundle({ output, env, maintenanceConfirmed: true, dumpDatabase: file => fs.writeFile(file, 'database') });
        assert.equal(manifest.sources.analysis, 'included');
        assert.equal(manifest.sources['document-processing'], 'absent');
        assert.equal(manifest.files.some(item => item.path.includes('/tmp/')), false);
        assert.equal(manifest.files.some(item => item.path === 'analysis/datasets/preserved.bin'), true);
        await verifyBackupBundle(output);
        await assert.rejects(createBackupBundle({ output: path.join(root, 'nested'), env: { ...env, PIVOT_ANALYSIS_DIR: sources.cas }, maintenanceConfirmed: true, dumpDatabase: file => fs.writeFile(file, 'database') }), /相互包含/);
        await fs.rm(path.join(output, 'agent-skills'), { recursive: true });
        await assert.rejects(verifyBackupBundle(output), /ENOENT|目录缺失/);
        await fs.mkdir(path.join(output, 'agent-skills'));
        await fs.writeFile(path.join(output, 'agent-skills', 'unlisted'), '额外内容');
        await assert.rejects(verifyBackupBundle(output), /未登记/);
        await fs.rm(path.join(output, 'agent-skills', 'unlisted'));
        await assert.rejects(createBackupBundle({ output: path.join(root, 'missing'), env: { ...env, PIVOT_DOCUMENT_PROCESSING_DIR: path.join(root, 'missing-docs') }, maintenanceConfirmed: true, dumpDatabase: file => fs.writeFile(file, 'database') }), error => error.code === 'ENOENT');
        const legacy = path.join(root, 'legacy');
        await fs.mkdir(legacy);
        await fs.writeFile(path.join(legacy, 'database.dump'), 'database');
        const crypto = require('node:crypto');
        const sha256 = crypto.createHash('sha256').update('database').digest('hex');
        await fs.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify({ version: 1, files: [{ path: 'database.dump', bytes: 8, sha256 }] }));
        assert.equal((await verifyBackupBundle(legacy)).version, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('图形拒绝脚本、外部资源和异常结构，安全矢量与 PNG 导出均可用', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>';
    assert.match(sanitizeSvg(svg), /rect/);
    assert.match(sanitizeSvg(svg.replace('<rect', '<style>@keyframes dash{to{stroke-dashoffset:0;}}</style><rect')), /keyframes/);
    for (const unsafe of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"></svg>', '<svg><use href="https://example.com/a"/></svg>', '<svg><style>@import "https://example.com/a";</style></svg>']) assert.throws(() => sanitizeSvg(unsafe));
    const ir = { ir_version: '1', doc_type: 'report', meta: { title: '流程图' }, blocks: [{ type: 'image', asset_ref: 'artifact-cas://0123456789abcdef' }] };
    const result = await renderDocumentIr(ir, 'png', { imageResolver: async () => Buffer.from(svg) });
    await assert.rejects(renderDocumentIr(ir, 'png', { imageResolver: async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use href="file:///etc/passwd"/></svg>') }), /外部资源/);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.buffer.subarray(1, 4).toString(), 'PNG');
    const report = await renderDocumentIr(auditReportIr({ status: 'completed', issues: [{ line: 1, column: 1, target: '<script>', risk: 'high', description: '风险' }] }), 'html');
    assert.match(report.buffer.toString(), /&lt;script&gt;/);
    assert.doesNotMatch(report.buffer.toString(), /<script>/);
});
