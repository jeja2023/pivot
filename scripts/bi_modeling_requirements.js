'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = 'docs/design/Pivot_BI数据建模产品级建设方案-2026-11-06.md';
const target = path.join(root, 'docs/reports/bi-modeling-requirements.json');
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// 逐块保留方案原文、行号及摘要；覆盖记录只能链接真实实现和验证，不能由扫描自动判定完成。
function collectClauses(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const clauses = [];
    let section = '', ordinal = 0, block = null, fenced = false;
    function flush() {
        if (!block) return;
        const content = block.lines.join('\n');
        clauses.push({ id: `BI-S${section.split('.')[0].padStart(2, '0')}-C${String(++ordinal).padStart(3, '0')}`, section,
            startLine: block.start, endLine: block.end, kind: block.kind, text: content, sha256: digest(content),
            implementation: [], verification: [], status: 'pending' });
        block = null;
    }
    lines.forEach((line, index) => {
        const heading = /^(#{2,3}) (\d+(?:\.\d+)*)[. ]/.exec(line);
        if (heading && !fenced) {
            flush();
            if (heading[1] === '##') ordinal = 0;
            section = heading[2];
            return;
        }
        if (!section) return;
        if (line.startsWith('```')) {
            if (!fenced) { flush(); block = { start: index + 1, end: index + 1, kind: 'example', lines: [] }; }
            block.lines.push(line); block.end = index + 1;
            fenced = !fenced;
            if (!fenced) flush();
            return;
        }
        if (fenced) { block.lines.push(line); block.end = index + 1; return; }
        if (!line.trim()) { flush(); return; }
        const row = /^\|/.test(line);
        if (row && /^\|[\s:|-]+$/.test(line)) return;
        const item = /^(?:- |\d+\. )/.test(line);
        if (row || item) flush();
        if (!block) block = { start: index + 1, end: index + 1, kind: row ? 'table-row' : item ? 'item' : 'paragraph', lines: [] };
        block.lines.push(line); block.end = index + 1;
        if (row || item) flush();
    });
    flush();
    return clauses;
}

function main() {
    const text = fs.readFileSync(path.join(root, source), 'utf8').replace(/\r\n/g, '\n');
    const clauses = collectClauses(text);
    if (process.argv.includes('--capture')) {
        if (fs.existsSync(target)) throw new Error('需求目录已存在，禁止覆盖已有实施与验证记录；请逐项核对来源变更。');
        const catalog = { catalogVersion: 1, source, sourceVersion: 'v2.0', sourceSha256: digest(text),
            verificationScope: '功能开发及本机隔离验证；用户明确暂不开展目标生产环境验证。',
            clauses };
        fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
        console.log(`已固定 BI 方案来源目录：${clauses.length} 个原文条目；全部保持待实施/待验证状态。`);
        return;
    }
    const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (process.argv.includes('--append-source')) {
        const reason = process.argv.find(arg => arg.startsWith('--reason='))?.slice('--reason='.length).trim();
        if (!reason || reason.length > 500) throw new Error('追加需求来源必须填写五百字以内的明确范围变更原因。');
        for (let index = 0; index < catalog.clauses.length; index++) {
            const expected = clauses[index], actual = catalog.clauses[index];
            if (!expected || expected.id !== actual.id || expected.sha256 !== actual.sha256 || expected.startLine !== actual.startLine) throw new Error('原需求条目发生变化，不能以追加方式覆盖已有记录。');
        }
        if (clauses.length <= catalog.clauses.length) throw new Error('来源没有新增条目，请核对追加范围。');
        catalog.sourceChanges ||= [];
        catalog.sourceChanges.push({ previousSha256: catalog.sourceSha256, nextSha256: digest(text), previousClauses: catalog.clauses.length, nextClauses: clauses.length, reason });
        catalog.clauses.push(...clauses.slice(catalog.clauses.length)); catalog.sourceSha256 = digest(text);
        fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
        console.log(`已追加明确授权的需求来源：${clauses.length} 条；原实施与验证记录保留，新增条目待实施。`);
        return;
    }
    if (catalog.sourceSha256 !== digest(text) || catalog.clauses.length !== clauses.length) throw new Error('BI 方案来源已变化，请核对范围及逐项需求映射，不能静默沿用旧完成结论。');
    for (let index = 0; index < clauses.length; index++) {
        const expected = clauses[index], actual = catalog.clauses[index];
        if (expected.id !== actual.id || expected.sha256 !== actual.sha256 || expected.startLine !== actual.startLine) throw new Error(`BI 原文映射失配：${expected.id}`);
        if (actual.status === 'verified' && (!actual.implementation.length || !actual.verification.length)) throw new Error(`BI 条目缺少实施或验证证据：${actual.id}`);
        if (catalog.catalogVersion >= 2) {
            const statuses = new Set(['local_evidence_linked', 'reference', 'scope_constraint', 'deferred_production', 'local_target_failed', 'local_acceptance_pending', 'verified']);
            if (!statuses.has(actual.status) || !actual.assessment?.trim()) throw new Error(`BI 条目缺少明确核对结论：${actual.id}`);
            if (!actual.implementation.length || !actual.verification.length) throw new Error(`BI 条目缺少可追踪来源：${actual.id}`);
            for (const file of [...actual.implementation, ...actual.verification]) {
                const resolved = typeof file === 'string' ? path.resolve(root, file) : '';
                if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`BI 条目来源无效：${actual.id}`);
            }
            if (['deferred_production', 'local_acceptance_pending'].includes(actual.status) && !actual.remaining?.trim()) throw new Error(`BI 条目缺少未完成范围：${actual.id}`);
        }
    }
    const verified = catalog.clauses.filter(clause => clause.status === 'verified').length;
    const linked = catalog.clauses.filter(clause => clause.implementation.length && clause.verification.length).length;
    console.log(`BI 来源一致性检查通过：${clauses.length} 条，已关联证据 ${linked} 条，整项验证标记 ${verified} 条；此检查不代表功能或生产门禁通过。`);
}

main();
