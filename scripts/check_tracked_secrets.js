const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tracked = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
const violations = [];
const secretKeyPattern = /(?:stealthSecret|PIVOT_STEALTH_SECRET)\s*[=:]\s*["']?([A-Za-z0-9_+\/-]{32,})/i;
const credentialUrlPattern = /(?:postgres(?:ql)?|mysql):\/\/[^\s:@]+:[^\s@]+@/i;
const tokenPattern = /\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/;

for (const relative of tracked) {
    const absolute = path.join(root, relative);
    let text;
    try {
        if (fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(absolute, 'utf8');
    } catch (_) {
        continue;
    }
    if (relative === 'config.json' && /"stealthSecret"\s*:\s*"[^"\s]+"/i.test(text)) {
        violations.push(`${relative}: config.json 不得包含 stealthSecret`);
    }
    const isFixture = /^(tests[\\/]|docs[\\/]|scripts[\\/](run_|setup_|check_))/i.test(relative);
    if (secretKeyPattern.test(text) && !isFixture && !relative.endsWith('.example') && !relative.endsWith('.example.json')) {
        violations.push(`${relative}: 检测到疑似密钥配置值`);
    }
    const placeholderCredential = /(?:postgres(?:ql)?|mysql):\/\/[^\s:@]+:(?:pass|password|change-me|replace[_-][^@]*|your[^@]*password|\*{3,})@/i.test(text);
    if (!isFixture && !placeholderCredential && (credentialUrlPattern.test(text) || tokenPattern.test(text))) {
        violations.push(`${relative}: 检测到疑似凭据或令牌`);
    }
}

if (violations.length) {
    console.error('跟踪文件秘密扫描失败：');
    violations.forEach(item => console.error(` - ${item}`));
    process.exit(1);
}
console.log(`跟踪文件秘密扫描通过：检查 ${tracked.length} 个文件。`);
