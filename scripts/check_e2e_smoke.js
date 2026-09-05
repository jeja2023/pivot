const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(file, marker) {
    const text = read(file);
    if (!text.includes(marker)) {
        throw new Error(`${file} 缺少必需的 E2E 标记: ${marker}`);
    }
}

function main() {
    const manifest = JSON.parse(read('package.json'));
    const requiredFiles = [
        'scripts/run_e2e_tests.js',
        'tests/e2e/playwright.config.js',
        'tests/e2e/smoke.spec.js'
    ];
    requiredFiles.forEach(file => {
        if (!fs.existsSync(path.join(root, file))) throw new Error(`缺少 E2E 核心文件: ${file}`);
    });

    assertIncludes('tests/e2e/playwright.config.js', 'PIVOT_E2E_BASE_URL');
    assertIncludes('scripts/run_e2e_tests.js', "path.join('tests', 'e2e', 'playwright.config.js')");
    assertIncludes('scripts/run_e2e_tests.js', 'PIVOT_E2E_OUTPUT_DIR');
    assertIncludes('tests/e2e/playwright.config.js', 'reuseExistingServer');
    assertIncludes('tests/e2e/smoke.spec.js', 'window.Pivot.modules["chat.ui"]');
    assertIncludes('tests/e2e/smoke.spec.js', 'window.Pivot.modules["chat.attachments"]');
    assertIncludes('tests/e2e/smoke.spec.js', '#rag-debug-history');
    assertIncludes('tests/e2e/smoke.spec.js', "tool_call_mode");
    assertIncludes('tests/e2e/smoke.spec.js', "E2E 流式回答");
    assertIncludes('tests/e2e/smoke.spec.js', "e2e-knowledge.md");
    assertIncludes('client/chat/partials/scripts.html', '/chat/pivot-core.js');
    assertIncludes('client/chat/partials/rag-debug-modal.html', 'id="rag-debug-history"');
    if (!manifest.scripts || manifest.scripts['test:e2e'] !== 'node scripts/run_e2e_tests.js') {
        throw new Error('package.json 缺少 test:e2e 测试运行脚本');
    }
    if (!manifest.devDependencies || !manifest.devDependencies['@playwright/test']) {
        throw new Error('package.json 缺少 @playwright/test 依赖包');
    }

    console.log('E2E 冒烟测试脚手架检查通过。');
}

main();
