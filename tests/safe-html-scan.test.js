const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findUnsafeHtmlSinks } = require('../scripts/check_safe_html_usage');

test('安全扫描识别 HTML 内联脚本中的注入入口', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-html-scan-'));
    const file = path.join(dir, 'page.html');
    try {
        fs.writeFileSync(file, '<script>\nelement.innerHTML = value;\n</script>');
        const findings = findUnsafeHtmlSinks(file, 'client/example/page.html');
        assert.equal(findings.length, 1);
        assert.equal(findings[0].line, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
