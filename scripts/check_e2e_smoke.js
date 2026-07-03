const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(file, marker) {
    const text = read(file);
    if (!text.includes(marker)) {
        throw new Error(`${file} is missing required E2E marker: ${marker}`);
    }
}

function main() {
    const manifest = JSON.parse(read('package.json'));
    const requiredFiles = [
        'tests/e2e/playwright.config.js',
        'tests/e2e/smoke.spec.js'
    ];
    requiredFiles.forEach(file => {
        if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing E2E file: ${file}`);
    });

    assertIncludes('tests/e2e/playwright.config.js', 'PIVOT_E2E_BASE_URL');
    assertIncludes('tests/e2e/playwright.config.js', 'reuseExistingServer');
    assertIncludes('tests/e2e/smoke.spec.js', 'window.Pivot.modules["chat.ui"]');
    assertIncludes('tests/e2e/smoke.spec.js', 'window.Pivot.modules["chat.attachments"]');
    assertIncludes('tests/e2e/smoke.spec.js', '#rag-debug-history');
    assertIncludes('client/chat/partials/scripts.html', '/chat/pivot-core.js');
    assertIncludes('client/chat/partials/rag-debug-modal.html', 'id="rag-debug-history"');
    if (!manifest.scripts || manifest.scripts['test:e2e'] !== 'playwright test --config tests/e2e/playwright.config.js') {
        throw new Error('package.json is missing test:e2e Playwright runner script');
    }
    if (!manifest.devDependencies || !manifest.devDependencies['@playwright/test']) {
        throw new Error('package.json is missing @playwright/test devDependency');
    }

    console.log('E2E smoke scaffold check passed.');
}

main();
