const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

// 依赖审计豁免清单。
// 只登记「上游确认暂时无法修复」的 high/critical 问题，且必须同时写明豁免理由和复查日期。
// 复查日期一过豁免自动失效、门禁转红，避免临时豁免沉淀成永久放行。
// 登记格式：
//     ['包名', {
//         patterns: [/GHSA-xxxx-xxxx-xxxx/i, /关键字/i],
//         reason: '上游尚未发布修复版本，已通过 xxx 缓解',
//         expiresOn: '2026-09-30' // 复查日期，过期后该豁免自动失效
//     }]
// 当前无需豁免：axios、js-yaml、sharp、body-parser、multer、@azure/msal-node 与 electron 的历史告警已通过依赖升级清零。
const allowed = new Map([]);
// npm audit 以安装包名匹配 advisory。转发/镜像包必须明确声明上游身份，
// 否则同版本 Excel 解析器的安全公告会被 npm audit 静默遗漏。
const UPSTREAM_ALIASES = new Map([
    ['@e965/xlsx', 'xlsx']
]);

function buildAuditInvocation(args, platform = process.platform, env = process.env) {
    if (platform === 'win32') {
        return {
            command: env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', 'npm.cmd', ...args]
        };
    }
    return { command: 'npm', args };
}

function parseJsonSafely(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (_) {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
                return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            } catch (_) {}
        }
        return null;
    }
}

function extractAuditErrorMessage(auditResult, rawOutput = '', stderr = '') {
    if (typeof auditResult?.error === 'string' && auditResult.error.trim()) {
        return auditResult.error.trim();
    }
    if (auditResult?.message && typeof auditResult.message === 'string' && auditResult.message.trim()) {
        return auditResult.message.trim();
    }
    if (auditResult?.error && typeof auditResult.error === 'object') {
        const err = auditResult.error;
        if (err.summary && typeof err.summary === 'string' && err.summary.trim()) return err.summary.trim();
        if (err.detail && typeof err.detail === 'string' && err.detail.trim()) return err.detail.trim();
        if (err.message && typeof err.message === 'string' && err.message.trim()) return err.message.trim();
        if (err.code) return String(err.code);
        try {
            const str = JSON.stringify(err);
            if (str && str !== '{}') return str;
        } catch (_) {}
    }
    if (stderr && stderr.trim()) {
        const lines = stderr.trim().split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('npm notice') && !l.includes('A complete log of this run'));
        if (lines.length) return lines.join('; ');
    }
    if (rawOutput && rawOutput.trim()) {
        const lines = rawOutput.trim().split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('{') && !l.startsWith('}') && !l.startsWith('"') && !l.startsWith('npm notice'));
        if (lines.length) return lines.join('; ');
    }
    return '未知错误';
}

function isTransientAuditError(message = '') {
    const text = String(message || '').toLowerCase();
    return (
        text.includes('econnreset') ||
        text.includes('etimedout') ||
        text.includes('econnrefused') ||
        text.includes('enotfound') ||
        text.includes('socket hang up') ||
        text.includes('timeout') ||
        text.includes('超时') ||
        text.includes('500') ||
        text.includes('502') ||
        text.includes('503') ||
        text.includes('504') ||
        text.includes('429') ||
        text.includes('fetch failed') ||
        text.includes('service unavailable') ||
        text.includes('gateway timeout') ||
        text.includes('bad gateway') ||
        text.includes('audit endpoint returned an error')
    );
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isOfflineBypassAllowed() {
    return process.env.PIVOT_AUDIT_ALLOW_OFFLINE === 'true' ||
        process.env.PIVOT_OFFLINE === 'true' ||
        process.argv.includes('--offline');
}

function runAudit({ omitDev = false, maxRetries = 3 } = {}) {
    const args = ['audit'];
    if (omitDev) args.push('--omit=dev');
    args.push('--audit-level=high', '--json');
    // 新版 Node 在 Windows 上直接 spawn npm.cmd 可能返回 EINVAL；通过 cmd.exe 调用静态命令参数。
    const invocation = buildAuditInvocation(args);

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });

        if (result.error) {
            lastError = new Error(`无法启动 npm audit：${result.error.message}`);
            if (attempt < maxRetries) {
                console.warn(`[audit:policy] 无法启动 npm audit（第 ${attempt} 次重试）：${result.error.message}`);
                sleepSync(1500 * attempt);
                continue;
            }
            throw lastError;
        }

        const output = result.stdout || result.stderr || '';
        if (!output.trim()) {
            lastError = new Error(`npm audit 未返回审计结果（退出码 ${result.status ?? '未知'}）`);
            if (attempt < maxRetries) {
                console.warn(`[audit:policy] npm audit 未返回数据，准备重试（第 ${attempt} 次）...`);
                sleepSync(1500 * attempt);
                continue;
            }
            throw lastError;
        }

        const auditResult = parseJsonSafely(output);
        if (!auditResult) {
            console.error(output);
            lastError = new Error('无法解析 npm audit 的 JSON 输出');
            if (attempt < maxRetries) {
                console.warn(`[audit:policy] npm audit 输出 JSON 解析异常，准备重试（第 ${attempt} 次）...`);
                sleepSync(1500 * attempt);
                continue;
            }
            throw lastError;
        }

        const hasError = Boolean(auditResult?.error || (result.status !== 0 && !auditResult?.vulnerabilities));
        if (hasError) {
            const detail = extractAuditErrorMessage(auditResult, output, result.stderr);
            lastError = new Error(`npm audit 执行失败：${detail}`);
            if (isTransientAuditError(detail)) {
                if (attempt < maxRetries) {
                    console.warn(`[audit:policy] 依赖审计服务遇到瞬态异常（第 ${attempt} 次）：${detail}，将在 ${attempt * 1.5}s 后重试...`);
                    sleepSync(1500 * attempt);
                    continue;
                }
                if (isOfflineBypassAllowed()) {
                    console.warn(`[audit:policy] 检测到离线环境配置，已允许跳过在线依赖审计：${detail}`);
                    return { vulnerabilities: {} };
                }
            }
            throw lastError;
        }

        return auditResult;
    }

    throw lastError || new Error('npm audit 执行超时或未知失败');
}

function getAliasPackageVersions(lock = {}, aliases = UPSTREAM_ALIASES) {
    const packages = lock.packages || {};
    const result = new Map();
    for (const [installedName, upstreamName] of aliases) {
        const version = String(packages[`node_modules/${installedName}`]?.version || '').trim();
        if (!version) throw new Error(`上游审计别名 ${installedName} 缺少 package-lock 版本信息`);
        result.set(upstreamName, version);
    }
    return result;
}

function requestJsonOnce(url, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'Pivot-Audit-Policy/1.0'
            },
            timeout: timeoutMs
        }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const error = new Error(`上游 advisory 查询返回 HTTP ${response.statusCode}`);
                    error.statusCode = response.statusCode;
                    reject(error);
                    return;
                }
                try { resolve(JSON.parse(text || '{}')); } catch (error) { reject(error); }
            });
        });
        request.once('timeout', () => request.destroy(new Error('上游 advisory 查询超时')));
        request.once('error', reject);
        request.end(body);
    });
}

async function requestJson(url, payload, timeoutMs = 10000, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await requestJsonOnce(url, payload, timeoutMs);
        } catch (error) {
            lastError = error;
            const isTransient = (error.statusCode && error.statusCode >= 500) ||
                isTransientAuditError(error.message);
            if (isTransient && attempt < maxRetries) {
                console.warn(`[audit:policy] 上游 advisory 查询遇到瞬态异常（第 ${attempt} 次重试）：${error.message}`);
                await new Promise(r => setTimeout(r, 1500 * attempt));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

function buildAliasAuditResult(advisories = {}, aliases = UPSTREAM_ALIASES) {
    const vulnerabilities = {};
    for (const [installedName, upstreamName] of aliases) {
        const items = Array.isArray(advisories[upstreamName]) ? advisories[upstreamName] : [];
        if (!items.length) continue;
        const severity = items.some(item => item.severity === 'critical') ? 'critical' : 'high';
        vulnerabilities[installedName] = {
            name: installedName,
            severity,
            fixAvailable: items.some(item => String(item.patched_versions || '').trim() && item.patched_versions !== '<0.0.0-0'),
            via: items.map(item => ({
                source: item.id || item.url || upstreamName,
                name: installedName,
                title: `[${upstreamName}] ${item.title || item.overview || '安全公告'}`,
                url: item.url || '',
                severity: item.severity || severity,
                range: item.vulnerable_versions || ''
            }))
        };
    }
    return { vulnerabilities };
}

async function runUpstreamAliasAudit({ root = path.resolve(__dirname, '..'), aliases = UPSTREAM_ALIASES, request = requestJson } = {}) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const versions = getAliasPackageVersions(lock, aliases);
    const payload = Object.fromEntries([...versions].map(([name, version]) => [name, [version]]));
    let advisories = {};
    try {
        advisories = await request('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', payload);
    } catch (error) {
        if (isOfflineBypassAllowed() && isTransientAuditError(error.message)) {
            console.warn(`[audit:policy] 检测到离线环境配置，已跳过上游别名 advisory 在线查询：${error.message}`);
            return { vulnerabilities: {} };
        }
        throw error;
    }
    return buildAliasAuditResult(advisories, aliases);
}

function selectAuditPackages(auditResult, packageNames) {
    const allVulnerabilities = auditResult?.vulnerabilities || {};
    const names = new Set(packageNames || []);
    const pending = [...names];
    // npm audit 用字符串 via 表示漏洞来自另一个包。桌面运行时从 Electron
    // 开始审计时必须保留这条传递闭包，否则会只留下没有 advisory 对象的父节点。
    while (pending.length > 0) {
        const name = pending.shift();
        const via = allVulnerabilities[name]?.via;
        for (const item of Array.isArray(via) ? via : []) {
            if (typeof item !== 'string' || names.has(item) || !allVulnerabilities[item]) continue;
            names.add(item);
            pending.push(item);
        }
    }
    const vulnerabilities = Object.fromEntries(
        Object.entries(allVulnerabilities).filter(([name]) => names.has(name))
    );
    return { ...auditResult, vulnerabilities };
}

function advisoryText(item) {
    if (!item || typeof item !== 'object') return String(item || '');
    return [item.source, item.name, item.title, item.url, item.severity, item.range].filter(Boolean).join(' ');
}

// 校验豁免登记本身是否完整、是否已过复查日期；返回值用于区分「有效豁免」和「豁免已失效」。
function evaluateException(packageName, advisory, exceptions = allowed) {
    const entry = exceptions.get(packageName);
    if (!entry) return { matched: false };

    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
    const text = advisoryText(advisory);
    if (!patterns.some(pattern => pattern.test(text))) return { matched: false };

    if (!entry.reason || !entry.expiresOn) {
        return { matched: true, valid: false, note: '豁免登记缺少理由或复查日期' };
    }

    const expiresAt = Date.parse(`${entry.expiresOn}T23:59:59`);
    if (!Number.isFinite(expiresAt)) {
        return { matched: true, valid: false, note: `豁免复查日期无法解析：${entry.expiresOn}` };
    }
    if (Date.now() > expiresAt) {
        return { matched: true, valid: false, note: `豁免已于 ${entry.expiresOn} 到期，请重新评估或修复` };
    }

    return { matched: true, valid: true, note: `${entry.reason}（复查日期 ${entry.expiresOn}）` };
}

// 按审计结果分流为「已接受豁免」和「必须处理」两类，供命令行执行和回归测试共用。
function classifyAuditFindings(auditResult, exceptions = allowed) {
    const vulnerabilities = (auditResult && auditResult.vulnerabilities) || {};
    const failures = [];
    const accepted = [];

    for (const [name, vuln] of Object.entries(vulnerabilities)) {
        if (!['high', 'critical'].includes(String(vuln.severity || '').toLowerCase())) continue;
        const advisories = Array.isArray(vuln.via) && vuln.via.length > 0 ? vuln.via : [vuln];
        const hasFix = Boolean(vuln.fixAvailable);
        for (const advisory of advisories) {
            if (typeof advisory === 'string') {
                // 若调用方没有把传递依赖一并选入，也不能静默放行。
                if (!vulnerabilities[advisory]) failures.push(`${name}: 传递高危依赖 ${advisory}`);
                continue;
            }
            const title = advisory.title || advisory.url || advisory.source || '未命名告警';
            const exception = evaluateException(name, advisory, exceptions);

            // 上游已经提供修复版本时不接受任何豁免，必须直接升级。
            if (exception.matched && exception.valid && !hasFix) {
                accepted.push(`${name}: ${title} —— ${exception.note}`);
                continue;
            }
            if (exception.matched && !exception.valid) {
                failures.push(`${name}: ${title} —— ${exception.note}`);
                continue;
            }
            if (exception.matched && hasFix) {
                failures.push(`${name}: ${title} —— 上游已有修复版本，不接受豁免，请直接升级`);
                continue;
            }
            failures.push(`${name}: ${title}`);
        }
    }

    return { accepted, failures };
}

async function main() {
    const production = classifyAuditFindings(runAudit({ omitDev: true }));
    const desktopRuntimeAudit = selectAuditPackages(runAudit(), ['electron']);
    const desktopRuntime = classifyAuditFindings(desktopRuntimeAudit);
    const upstreamAlias = classifyAuditFindings(await runUpstreamAliasAudit());
    const accepted = [
        ...production.accepted.map(item => `[production] ${item}`),
        ...desktopRuntime.accepted.map(item => `[desktop-runtime] ${item}`),
        ...upstreamAlias.accepted.map(item => `[upstream-alias] ${item}`)
    ];
    const failures = [
        ...production.failures.map(item => `[production] ${item}`),
        ...desktopRuntime.failures.map(item => `[desktop-runtime] ${item}`),
        ...upstreamAlias.failures.map(item => `[upstream-alias] ${item}`)
    ];

    if (accepted.length > 0) {
        console.log('已接受的临时依赖审计豁免：');
        accepted.forEach(item => console.log(` - ${item}`));
    }

    if (failures.length > 0) {
        console.error('存在未豁免的 high/critical 依赖审计问题：');
        failures.forEach(item => console.error(` - ${item}`));
        console.error('请升级对应依赖；确认上游暂时无法修复时，在 scripts/check_audit_policy.js 的豁免清单中登记理由与复查日期。');
        process.exit(1);
    }

    console.log('依赖审计策略检查通过。');
}

if (require.main === module) {
    main().catch(error => {
        console.error(`依赖审计策略检查失败：${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    buildAuditInvocation,
    buildAliasAuditResult,
    classifyAuditFindings,
    evaluateException,
    extractAuditErrorMessage,
    getAliasPackageVersions,
    isOfflineBypassAllowed,
    isTransientAuditError,
    parseJsonSafely,
    runAudit,
    runUpstreamAliasAudit,
    selectAuditPackages
};
