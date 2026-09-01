const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    assertRegisteredCapabilities,
    capabilitiesCoverTool,
    capabilityCoveredBy,
    isRegisteredCapability
} = require('../server/services/agent-capability-registry');
const { resolveRegisteredToolCapabilities } = require('../server/services/agent-tool-capabilities');
const { normalizeToolContract } = require('../server/services/agent-contracts');
const {
    buildDeliveryFilename,
    isSymlinkExternalAttributes,
    isWindowsReservedName,
    normalizeRelativeEntryPath,
    resolveNonConflictingPath
} = require('../server/services/agent-path-safety');
const { deriveOwnerKey, normalizeReleaseScope, parseOwnerKey, toLegacyScope } = require('../server/services/agent-skill-scope');
const {
    chooseRolloutRelease,
    computeRolloutBucket,
    evaluateBreaker,
    normalizeBreakerThresholds
} = require('../server/services/agent-skill-rollout');
const { resolveTenantContext, DEFAULT_TENANT_ID } = require('../server/services/agent-tenant-context');
const { validateSkillManifest } = require('../server/services/agent-skills');
const { parseSkillSourceMarkdown, buildSkillSourceMarkdown } = require('../server/services/agent-skill-source');
const { scanSkillPackageEntries } = require('../server/services/agent-skill-supply-chain');
const { runDeclarativeSkillChecks } = require('../server/services/agent-releases');
const { canonicalizeDocumentIr, computeIrDigest, validateDocumentIr } = require('../server/services/document-ir');
const { listRendererStatus, renderDocumentIr } = require('../server/services/document-rendering');
const { buildIdempotencyKey } = require('../server/services/agent-artifact-delivery');
const { verifySignatureWithPublicKey, computeKeyFingerprint } = require('../server/services/agent-local-devices');
const { getAgentGovernanceStatus } = require('../server/services/agent-governance-status');
const { normalizeDefinition, runCapabilityWorker } = require('../server/services/agent-capability-worker');

const NEWLINE = String.fromCharCode(10);

function officialIr(overrides = {}) {
    return {
        ir_version: '1',
        doc_type: 'official_document',
        meta: { title: '关于开展年度核查的通知', doc_number: '示例〔2026〕1 号', issuer: '示例单位', issued_at: '2026-08-31' },
        blocks: [
            { type: 'heading', level: 1, text: '一、总体要求' },
            { type: 'paragraph', runs: [{ text: '正文示例内容。' }], style: { indent_chars: 2, line_height: 1.5 } },
            { type: 'table', header: ['项目', '数量'], rows: [['台账核对', '12']], widths_pct: [70, 30] },
            { type: 'list', ordered: true, items: ['第一项', '第二项'] },
            { type: 'page_break' }
        ],
        footer: { page_number: true, format: '— {page} —' },
        ...overrides
    };
}

test('能力注册表只允许父能力覆盖子能力，关闭窄能力匹配宽能力的放大路径', () => {
    assert.equal(capabilityCoveredBy('filesystem.read', 'filesystem.read_workspace'), true);
    assert.equal(capabilityCoveredBy('code.execute', 'code.python_execute'), true);
    assert.equal(capabilityCoveredBy('code.python_execute', 'code.execute'), false);
    assert.equal(capabilityCoveredBy('data.duckdb.query', 'code.execute'), false);
    assert.equal(capabilityCoveredBy('agent.execute', 'filesystem.write'), false);
    assert.equal(capabilitiesCoverTool([], ['code.execute']), false);
    assert.equal(capabilitiesCoverTool(['code.execute'], []), false);
    assert.equal(isRegisteredCapability('data.duckdb.query'), true);
    assert.equal(isRegisteredCapability('code.duckdb_query'), false);
    const checked = assertRegisteredCapabilities(['code.execute', 'not.registered']);
    assert.deepEqual(checked.unknown, ['not.registered']);
});

test('治理观测快照公开 PEP shadow/enforce 模式、渲染器与计数器', () => {
    const shadow = getAgentGovernanceStatus({ PIVOT_AGENT_PEP_MODE: 'shadow' });
    assert.equal(shadow.pep.mode, 'shadow');
    assert.ok(Array.isArray(shadow.renderers));
    assert.ok(shadow.metrics.pep.shadowDenyTotal);
    const enforce = getAgentGovernanceStatus({ PIVOT_AGENT_PEP_MODE: 'invalid' });
    assert.equal(enforce.pep.mode, 'enforce');
});

test('Capability Worker 只接受固定摘要镜像并在未启用时 fail-closed', async () => {
    assert.throws(() => normalizeDefinition({ image: 'registry.local/runner:latest', command: ['runner'] }), /sha256/);
    const spec = normalizeDefinition({ image: `registry.local/pivot/runner@sha256:${'a'.repeat(64)}`, command: ['/opt/pivot/runner'], limits: { cpu: 8, memoryMb: 9999 } });
    assert.equal(spec.limits.cpu, 2);
    assert.equal(spec.limits.memoryMb, 2048);
    await assert.rejects(
        () => runCapabilityWorker(spec, {}, { env: { PIVOT_CAPABILITY_WORKER_ENABLED: 'false' } }),
        error => error.code === 'CAPABILITY_WORKER_DISABLED'
    );
});

test('工具能力由登记表解析，名称关键字不再放大能力', () => {
    assert.deepEqual(resolveRegisteredToolCapabilities('agent.code'), ['code.sandbox_eval']);
    assert.deepEqual(resolveRegisteredToolCapabilities('db.run_readonly_query', 'mcp'), ['data.sql.query']);
    // MCP 全名与裸名必须解析到同一能力，否则同一工具会因调用名不同拿到不同权限。
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.3.db.run_readonly_query', 'mcp'), ['data.sql.query']);
    assert.deepEqual(resolveRegisteredToolCapabilities('report.compose'), ['viz.render']);
    assert.deepEqual(resolveRegisteredToolCapabilities('unknown.tool'), ['agent.execute']);
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.9.unknown', 'mcp'), ['network.request']);
    // 契约声明了未登记能力时不得因此获得更宽的权限。
    assert.deepEqual(normalizeToolContract({ name: 'agent.http', capabilities: ['bogus.cap'] }).capabilities, ['network.http_request']);
    assert.deepEqual(normalizeToolContract({ name: 'x.y', capabilities: ['data.duckdb.query'] }).capabilities, ['data.duckdb.query']);
});

test('路径安全工具拒绝穿越、符号链接、保留名、ADS 与尾随空格', () => {
    assert.equal(normalizeRelativeEntryPath('a/b.txt'), 'a/b.txt');
    assert.throws(() => normalizeRelativeEntryPath('../escape.txt'), /越权/);
    assert.throws(() => normalizeRelativeEntryPath('a/../../b'), /越权/);
    assert.throws(() => normalizeRelativeEntryPath('/etc/passwd'), /绝对路径/);
    assert.throws(() => normalizeRelativeEntryPath('C:' + String.fromCharCode(92) + 'win'), /绝对路径/);
    assert.throws(() => normalizeRelativeEntryPath('CON'), /保留名/);
    assert.throws(() => normalizeRelativeEntryPath('x/CON.txt'), /保留名/);
    assert.throws(() => normalizeRelativeEntryPath('file.txt:stream'), /备用数据流/);
    assert.throws(() => normalizeRelativeEntryPath('trail '), /空格或点/);
    assert.equal(isWindowsReservedName('nul.docx'), true);
    assert.equal(isSymlinkExternalAttributes(0xA1FF0000), true);
    assert.equal(isSymlinkExternalAttributes(0x81A40000), false);
    // 扩展名由服务端按 format 决定，不接受可执行扩展名。
    assert.equal(buildDeliveryFilename('../../evil.exe', 'pdf'), 'evil.pdf');
    assert.equal(buildDeliveryFilename('年度报告', 'docx'), '年度报告.docx');
    assert.throws(() => buildDeliveryFilename('x', 'exe'), /不支持的交付格式/);
    const existing = new Set(['/root/年度报告.docx', '/root/年度报告 (2).docx']);
    const resolved = resolveNonConflictingPath('/root', '年度报告.docx', { exists: target => existing.has(String(target).replace(/\\/g, '/')) });
    assert.equal(String(resolved).replace(/\\/g, '/'), '/root/年度报告 (3).docx');
});

test('ownerKey 一律由服务端按作用域推导，作用域枚举双向映射稳定', () => {
    assert.equal(deriveOwnerKey({ scope: 'personal', userId: 7 }), 'user:7');
    assert.equal(deriveOwnerKey({ scope: 'organization', userId: 7, tenantId: 3 }), 'org:3');
    assert.equal(deriveOwnerKey({ scope: 'team', userId: 7, tenantId: 3, teamId: 9 }), 'team:9');
    assert.throws(() => deriveOwnerKey({ scope: 'team', userId: 7, tenantId: 3 }), /必须指定团队/);
    assert.throws(() => deriveOwnerKey({ scope: 'organization', userId: 7 }), /解析出租户/);
    assert.equal(normalizeReleaseScope('shared'), 'team');
    assert.equal(normalizeReleaseScope('global'), 'organization');
    assert.equal(normalizeReleaseScope('user'), 'personal');
    assert.throws(() => normalizeReleaseScope('everyone'), /personal/);
    assert.equal(toLegacyScope('team'), 'shared');
    assert.equal(parseOwnerKey('scope:global').legacy, true);
    assert.equal(parseOwnerKey('team:9').id, 9);
});

test('灰度分桶对每个候选独立计算且以租户密钥做 HMAC', () => {
    const base = { tenantId: 1, userId: 42 };
    const bucketA = computeRolloutBucket({ ...base, releaseId: 100 });
    const bucketB = computeRolloutBucket({ ...base, releaseId: 101 });
    assert.notEqual(bucketA, bucketB, '不同候选必须得到独立桶位');
    assert.equal(computeRolloutBucket({ ...base, releaseId: 100 }), bucketA, '同输入桶位必须稳定');
    // 裸 sha256 可被外部预测；换用租户密钥后同一 userId+releaseId 在不同密钥版本下桶位不同。
    assert.notEqual(computeRolloutBucket({ ...base, releaseId: 100, secretVersion: 2 }), bucketA);
    const candidates = [
        { id: 100, status: 'published', tenant_id: 1, rollout_percent: 0, target_user_ids: '[]', target_units: '[]' },
        { id: 101, status: 'published', tenant_id: 1, rollout_percent: 100, target_user_ids: '[]', target_units: '[]' }
    ];
    assert.equal(chooseRolloutRelease(candidates, { id: 42 }, {}).id, 101, 'rollout_percent=0 必须零命中');
    assert.equal(chooseRolloutRelease([candidates[0]], { id: 42 }, {}), null);
    const teamScoped = [{ id: 102, status: 'published', tenant_id: 1, rollout_percent: 100, target_user_ids: '[]', target_units: '[9]' }];
    assert.equal(chooseRolloutRelease(teamScoped, { id: 42 }, { teamIds: [] }), null, '未命中目标团队必须返回空');
    assert.equal(chooseRolloutRelease(teamScoped, { id: 42 }, { teamIds: [9] }).id, 102);
});

test('熔断阈值在样本量不足时不触发，超阈值时给出命中原因', () => {
    const thresholds = normalizeBreakerThresholds({ minSamples: 10, policyDenyRate: 0.3 });
    assert.equal(evaluateBreaker(thresholds, { samples: 5, policyDenied: 5 }).tripped, false);
    const tripped = evaluateBreaker(thresholds, { samples: 20, policyDenied: 10 });
    assert.equal(tripped.tripped, true);
    assert.equal(tripped.reason, 'policy_deny_rate');
});

test('企业访问开启且用户无团队时租户不可解析，关闭时才使用默认租户', async () => {
    const closed = await resolveTenantContext({ id: 0 }, { enterpriseAccess: false });
    assert.equal(closed.resolvable, true);
    assert.equal(closed.tenantId, DEFAULT_TENANT_ID);
    assert.equal(closed.usedDefault, true);
    const opened = await resolveTenantContext({ id: 0 }, { enterpriseAccess: true });
    assert.equal(opened.resolvable, false);
    assert.equal(opened.tenantId, null);
    const direct = await resolveTenantContext({ id: 0, tenant_id: 8 }, { enterpriseAccess: true });
    assert.equal(direct.tenantId, 8);
});

test('Skill 清单校验登记能力并在严格模式下要求完整声明', () => {
    const legacy = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0', permissions: ['code.execute'] });
    assert.equal(legacy.valid, true);
    assert.deepEqual(legacy.capabilities, ['code.execute']);
    const unregistered = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0', capabilities: ['code.duckdb_query'] });
    assert.equal(unregistered.valid, false);
    assert.match(unregistered.errors.join(' '), /未登记的能力/);
    const strict = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0' }, { strictSpec: true });
    assert.equal(strict.valid, false);
    assert.match(strict.errors.join(' '), /schemaVersion/);
    assert.match(strict.errors.join(' '), /capabilities 不能为空/);
    const scoped = validateSkillManifest({
        schemaVersion: 1, id: 'corp.demo', name: 'demo', version: '1.0.0', scope: 'global',
        capabilities: ['data.duckdb.query'], tools: ['duckdb.query'], inputs: {}, outputs: {}
    }, { strictSpec: true });
    assert.equal(scoped.valid, false);
    assert.match(scoped.errors.join(' '), /scope 不再被接受/);
});

test('SKILL.md 只接受白名单字段并拒绝 YAML 间接引用，导入导出可往返', () => {
    const markdown = [
        '---',
        'schemaVersion: 1',
        'id: corp.finance.review',
        'name: financial-review',
        'version: 1.0.0',
        'title: 财务分析助手',
        'tools:',
        '  - rag.search',
        'capabilities:',
        '  - knowledge.search',
        'inputs:',
        '  financial_excel:',
        '    type: file',
        'outputs:',
        '  risk_summary:',
        '    type: document_request',
        '---',
        '',
        '# 工作指引',
        '仅基于用户提供的数据进行分析。'
    ].join(NEWLINE);
    const parsed = parseSkillSourceMarkdown(markdown);
    assert.equal(parsed.manifest.id, 'corp.finance.review');
    assert.deepEqual(parsed.manifest.capabilities, ['knowledge.search']);
    assert.match(parsed.instructions, /工作指引/);
    const rebuilt = buildSkillSourceMarkdown(parsed.manifest, parsed.instructions);
    assert.deepEqual(parseSkillSourceMarkdown(rebuilt).manifest.tools, ['rag.search']);
    assert.throws(() => parseSkillSourceMarkdown(['---', 'id: x', 'extraField: 1', '---', ''].join(NEWLINE)), /未知字段/);
    assert.throws(() => parseSkillSourceMarkdown(['---', 'id: &anchor x', '---', ''].join(NEWLINE)), /锚点/);
    assert.throws(() => parseSkillSourceMarkdown(['---', 'scope: global', '---', ''].join(NEWLINE)), /scope 不再被接受/);
    assert.throws(() => parseSkillSourceMarkdown(['---', 'id: x', 'id: y', '---', ''].join(NEWLINE)), /解析失败/);
    assert.throws(() => parseSkillSourceMarkdown('没有 Frontmatter 的正文'), /Frontmatter/);
});

test('供应链扫描针对实际条目，声明式验证不执行包内脚本', () => {
    const manifest = { id: 'corp.demo', name: 'demo', version: '1.0.0' };
    assert.equal(scanSkillPackageEntries([{ name: 'SKILL.yaml', data: Buffer.from('id: x') }], manifest).passed, true);
    const sensitive = scanSkillPackageEntries([{ name: '.env', data: Buffer.from('SECRET=1') }], manifest);
    assert.equal(sensitive.passed, false);
    assert.match(sensitive.errors.join(' '), /敏感文件/);
    const symlink = scanSkillPackageEntries([{ name: 'link', data: Buffer.alloc(0), externalFileAttributes: 0xA1FF0000 }], manifest);
    assert.match(symlink.errors.join(' '), /符号链接/);
    const bomb = scanSkillPackageEntries([{ name: 'big.txt', data: Buffer.alloc(0), compressedSize: 2048, uncompressedSize: 2048 * 500 }], manifest);
    assert.match(bomb.errors.join(' '), /压缩比/);
    const declarative = runDeclarativeSkillChecks({
        manifest: { tests: [{ name: 'smoke', script: 'process.exit(0)' }] },
        capabilities: ['knowledge.search'],
        tools: ['rag.search']
    });
    assert.equal(declarative.scriptsExecuted, false);
    assert.equal(declarative.passed, false);
    assert.match(declarative.errors.join(' '), /可执行脚本已被禁止/);
    const covered = runDeclarativeSkillChecks({ manifest: {}, capabilities: ['knowledge.read'], tools: ['rag.search'] });
    assert.equal(covered.passed, true);
    const uncovered = runDeclarativeSkillChecks({ manifest: {}, capabilities: ['agent.execute'], tools: ['rag.search'] });
    assert.equal(uncovered.passed, false);
    assert.match(uncovered.errors.join(' '), /未覆盖工具/);
    const unknownTool = runDeclarativeSkillChecks({ manifest: {}, capabilities: ['agent.execute'], tools: ['ghost.tool'] });
    assert.match(unknownTool.errors.join(' '), /未在平台登记/);
});

test('Document IR 白名单校验拒绝非法块与内联图片，并保证规范化摘要稳定', () => {
    const checked = validateDocumentIr(officialIr());
    assert.equal(checked.valid, true);
    assert.deepEqual(checked.ir.meta.page.margin_mm, { top: 37, bottom: 35, left: 28, right: 26 });
    assert.equal(computeIrDigest(checked.ir), computeIrDigest(canonicalizeDocumentIr(officialIr())));
    const memo = validateDocumentIr({ ir_version: '1', doc_type: 'memo', meta: { title: 'x' }, blocks: [{ type: 'table', header: ['a'], rows: [] }] });
    assert.equal(memo.valid, false);
    assert.match(memo.errors.join(' '), /不允许块类型 table/);
    const inline = validateDocumentIr({ ir_version: '1', doc_type: 'report', meta: { title: 'x' }, blocks: [{ type: 'image', asset_ref: 'data:image/png;base64,AAA' }] });
    assert.equal(inline.valid, false);
    assert.match(inline.errors.join(' '), /artifact-cas/);
    const unknownField = validateDocumentIr({ ir_version: '1', doc_type: 'report', meta: { title: 'x' }, blocks: [{ type: 'heading', level: 1, text: 'a' }], extra: 1 });
    assert.equal(unknownField.valid, false);
    const mismatched = validateDocumentIr({ ir_version: '1', doc_type: 'report', meta: { title: 'x' }, blocks: [{ type: 'table', header: ['a', 'b'], rows: [['1']] }] });
    assert.equal(mismatched.valid, false);
    assert.match(mismatched.errors.join(' '), /列数/);
});

test('渲染器输出确定性，公文 DOCX 满足结构与度量断言且页脚不含 ASCII 问号', async () => {
    const checked = validateDocumentIr(officialIr());
    const statuses = listRendererStatus();
    assert.deepEqual(statuses.map(item => item.format).sort(), ['docx', 'html', 'md', 'pdf', 'xlsx']);
    for (const format of ['docx', 'xlsx', 'html', 'md']) {
        const first = await renderDocumentIr(checked.ir, format, { skipValidation: true });
        const second = await renderDocumentIr(checked.ir, format, { skipValidation: true });
        assert.equal(
            crypto.createHash('sha256').update(first.buffer).digest('hex'),
            crypto.createHash('sha256').update(second.buffer).digest('hex'),
            `${format} 渲染必须幂等`
        );
    }
    const unzipper = require('unzipper');
    const docx = await renderDocumentIr(checked.ir, 'docx', { skipValidation: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-docx-assert-'));
    try {
        const target = path.join(root, 'official.docx');
        fs.writeFileSync(target, docx.buffer);
        const directory = await unzipper.Open.file(target);
        const parts = {};
        for (const file of directory.files) {
            if (file.type === 'Directory') continue;
            parts[file.path] = (await file.buffer()).toString('utf8');
        }
        const document = parts['word/document.xml'] || '';
        assert.match(document, /<w:document/);
        assert.ok(parts['word/styles.xml'], 'styles.xml 必须存在');
        assert.match(document, /<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
        const margins = /<w:pgMar([^>]*)\/>/.exec(document);
        assert.ok(margins, 'sectPr 必须包含页边距');
        const twip = mm => Math.round(mm * 1440 / 25.4);
        [['top', 37], ['bottom', 35], ['left', 28], ['right', 26]].forEach(([side, mm]) => {
            const found = new RegExp(`w:${side}="(-?\\d+)"`).exec(margins[1]);
            assert.ok(found, `页边距缺少 ${side}`);
            assert.ok(Math.abs(Number(found[1]) - twip(mm)) <= 2, `${side} 页边距应约为 ${twip(mm)} twip，实际 ${found[1]}`);
        });
        assert.match(document, /w:eastAsia="[^"]+"/);
        assert.match(document, /<w:sz w:val="\d+"/);
        assert.match(document, /w:firstLine(Chars)?="\d+"/);
        assert.match(document, /<w:spacing[^>]*w:line="\d+"/);
        const grid = /<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(document);
        assert.ok(grid, '表格必须输出 tblGrid');
        assert.equal((grid[1].match(/<w:gridCol/g) || []).length, 2, 'tblGrid 列数必须与 IR 表头一致');
        const footer = Object.entries(parts).filter(([name]) => /word\/footer\d*\.xml/.test(name)).map(([, value]) => value).join('');
        assert.match(footer, /PAGE/, '页脚必须包含 PAGE 域');
        assert.doesNotMatch(footer.replace(/<[^>]*>/g, ''), /\?/, '页脚文本不得出现 ASCII 问号占位');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('未提供 CJK 字体资产时 PDF 渲染能力显式下线并拒绝渲染', async () => {
    const { resetCjkFontCache } = require('../server/services/document-rendering/cjk-fonts');
    const previousDir = process.env.PIVOT_PDF_FONT_DIR;
    const previousFile = process.env.PIVOT_PDF_FONT_FILE;
    process.env.PIVOT_PDF_FONT_DIR = path.join(os.tmpdir(), 'pivot-missing-font-dir');
    process.env.PIVOT_PDF_FONT_FILE = 'not-exists.ttf';
    resetCjkFontCache();
    try {
        const status = listRendererStatus().find(item => item.format === 'pdf');
        assert.equal(status.available, false);
        await assert.rejects(
            () => renderDocumentIr(validateDocumentIr(officialIr()).ir, 'pdf', { skipValidation: true }),
            error => error.code === 'DOCUMENT_RENDERER_UNAVAILABLE'
        );
    } finally {
        if (previousDir === undefined) delete process.env.PIVOT_PDF_FONT_DIR; else process.env.PIVOT_PDF_FONT_DIR = previousDir;
        if (previousFile === undefined) delete process.env.PIVOT_PDF_FONT_FILE; else process.env.PIVOT_PDF_FONT_FILE = previousFile;
        resetCjkFontCache();
    }
});

test('交付幂等键由服务端规范化字段生成并包含发起人', () => {
    const base = { tenantId: 1, requestedBy: 5, runId: 'run-1', renditionId: 9, channel: 'local_device', deviceId: 'dev-1', targetDirGrant: 'g1', targetFilename: 'a.docx' };
    assert.equal(buildIdempotencyKey(base), buildIdempotencyKey({ ...base }));
    assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, requestedBy: 6 }));
    assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, deviceId: 'dev-2' }));
    assert.match(buildIdempotencyKey(base), /^[0-9a-f]{64}$/);
});

test('设备签名校验同时支持 Ed25519 与 RSA，且换用其它密钥即失败', () => {
    const ed = crypto.generateKeyPairSync('ed25519');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const payload = 'attest:abc:device-1';
    const edPublic = ed.publicKey.export({ type: 'spki', format: 'pem' });
    const edSignature = crypto.sign(null, Buffer.from(payload, 'utf8'), ed.privateKey).toString('base64');
    assert.equal(verifySignatureWithPublicKey(edPublic, payload, edSignature), true);
    assert.equal(verifySignatureWithPublicKey(edPublic, 'attest:abc:device-2', edSignature), false);
    const signer = crypto.createSign('sha256');
    signer.update(payload);
    signer.end();
    const rsaSignature = signer.sign(rsa.privateKey).toString('base64');
    const rsaPublic = rsa.publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(verifySignatureWithPublicKey(rsaPublic, payload, rsaSignature), true);
    // 冒用他人已注册的公钥但不持有对应私钥时必须失败。
    assert.equal(verifySignatureWithPublicKey(rsaPublic, payload, edSignature), false);
    assert.match(computeKeyFingerprint(edPublic), /^[0-9a-f]{64}$/);
});

test('文本完整性门禁已扩展为检出中文上下文中的孤立 ASCII 问号', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check_text_integrity.js'), 'utf8');
    assert.match(source, /collectQuestionMarkIssues/);
    assert.match(source, /isolated ASCII question mark in Chinese text/);
    assert.match(source, /suspicious standalone ASCII question mark/);
    // 临时目录不参与判定，否则本地脚本会把门禁拖成假失败。
    assert.match(source, /'\.tmp'/);
});
