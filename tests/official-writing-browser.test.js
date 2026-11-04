/* global window, Response, File, TextEncoder, DataTransfer, ClipboardEvent, document, showOfficialWritingApp, openOfficialWritingDrawer, buildOfficialWritingDocumentIr, setTextareaSelection, getOfficialWritingTextarea, requestOfficialWritingAi, importOfficialWritingBackup, resolveOfficialWritingVersionSource, importOfficialWritingMaterialFiles, switchOfficialWritingDoc, setOfficialWritingTextareaValue, officialWritingState, syncOfficialWritingStateFromInputs, runOfficialWritingAiTask, officialWritingLibrary, createOfficialWritingDoc, applySuggestionAction, loadOfficialWritingState */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createOfficialWritingPage } = require('./helpers/official-writing-browser');

test('公文逐字输入、换行、中文组合、选区、撤销重做保持内容与光标', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const draft = page.locator('#official-writing-draft-surface');
        await draft.click();
        await page.keyboard.type('abc');
        assert.equal(await draft.innerText(), 'abc');
        await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('def');
        assert.equal(await draft.innerText(), 'abc\n\ndef');
        await page.keyboard.press('Control+z');
        assert.equal(await draft.textContent(), 'abc\n\n');
        assert.equal(await page.locator('#official-writing-draft').inputValue(), 'abc\n\n');
        await page.keyboard.press('Control+y');
        assert.equal(await draft.innerText(), 'abc\n\ndef');
        await page.locator('#official-writing-back-to-library-btn').click();
        assert.equal(await page.evaluate(() => window.testDocs.values().next().value.state.draft), 'abc\n\ndef');
        await page.evaluate(() => switchOfficialWritingDoc(officialWritingLibrary.docs.find(doc => doc.title === '浏览器测试文档').id));
        await draft.click();
        await page.keyboard.press('Control+End');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.insertText', { text: '你' });
        assert.equal(await draft.innerText(), 'abc\n\ndef你');
        await page.keyboard.press('Control+z');
        assert.equal(await draft.innerText(), 'abc\n\ndef');
        await page.evaluate(() => setTextareaSelection(getOfficialWritingTextarea('draft'), 5));
        await page.keyboard.press('Backspace');
        assert.equal(await draft.textContent(), 'abc\ndef');
        await page.keyboard.press('Control+z');
        assert.equal(await draft.textContent(), 'abc\n\ndef');
        await page.evaluate(() => {
            setTextareaSelection(getOfficialWritingTextarea('draft'), 0, 3);
            const data = new DataTransfer(); data.setData('text/plain', '甲\n\n乙');
            document.getElementById('official-writing-draft-surface').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        assert.equal(await draft.textContent(), '甲\n\n乙\n\ndef');
        await page.keyboard.press('Control+z');
        assert.equal(await draft.textContent(), 'abc\n\ndef');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('公文 AI 结果绑定文档且保留等待期间编辑，部分输出不能采纳', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        await page.evaluate(() => {
            setOfficialWritingTextareaValue('draft', 'A原稿'); syncOfficialWritingStateFromInputs();
            window.aId = officialWritingLibrary.activeId;
            window.testApiOverride = async url => {
                if (!url.endsWith('/ai')) return;
                return new Promise(resolve => { window.releaseAi = () => resolve(new Response('data: {"choices":[{"delta":{"content":"A生成结果"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); });
            };
            window.aiTask = runOfficialWritingAiTask('draft');
        });
        await page.waitForFunction(() => !!window.releaseAi);
        await page.evaluate(() => { createOfficialWritingDoc({ title: 'B文档' }); setOfficialWritingTextareaValue('draft', 'B必须保留'); syncOfficialWritingStateFromInputs(); window.releaseAi(); });
        await page.evaluate(() => window.aiTask);
        assert.equal(await page.evaluate(() => officialWritingState.draft), 'B必须保留');
        assert.equal(await page.evaluate(() => officialWritingLibrary.docs.find(doc => doc.id === window.aId).state.suggestions[0].replacement), 'A生成结果');
        await page.evaluate(() => switchOfficialWritingDoc(window.aId));
        assert.equal(await page.evaluate(() => officialWritingState.draft), 'A原稿');
        await page.evaluate(() => applySuggestionAction(officialWritingState.suggestions[0].id, 'replace'));
        assert.equal(await page.evaluate(() => officialWritingState.draft), 'A生成结果');
        await page.evaluate(() => {
            window.testApiOverride = async url => url.endsWith('/ai') ? new Response('data: {"choices":[{"delta":{"content":"半篇"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n') : null;
        });
        await page.evaluate(() => runOfficialWritingAiTask('draft'));
        assert.equal(await page.evaluate(() => officialWritingState.suggestions[0].canApply), false);
        await page.evaluate(() => applySuggestionAction(officialWritingState.suggestions[0].id, 'replace'));
        assert.equal(await page.evaluate(() => officialWritingState.draft), 'A生成结果');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('公文连续建议重新定位、重复应用幂等、说明不写入正文，列表失败不清空草稿', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const result = await page.evaluate(async () => {
            setOfficialWritingTextareaValue('draft', '甲乙丙丁'); syncOfficialWritingStateFromInputs();
            officialWritingState.suggestions = [
                { id: 'one', status: 'pending', target: 'draft', ...window.Pivot.moduleApi('apps.officialWritingDocument').anchor('甲乙丙丁', 0, 1), replacement: '甲甲甲', canApply: true },
                { id: 'two', status: 'pending', target: 'draft', ...window.Pivot.moduleApi('apps.officialWritingDocument').anchor('甲乙丙丁', 2, 3), replacement: '新', canApply: true },
                { id: 'note', status: 'pending', replacement: '建议修改', canApply: false }
            ];
            applySuggestionAction('one', 'replace'); applySuggestionAction('two', 'replace');
            applySuggestionAction('two', 'replace'); applySuggestionAction('note', 'replace');
            const expected = officialWritingState.draft;
            const activeId = officialWritingLibrary.activeId;
            window.testApiOverride = async url => url.includes('/documents?') ? new Response('{}', { status: 503 }) : null;
            const loaded = await loadOfficialWritingState();
            return { expected, after: officialWritingState.draft, sameDoc: officialWritingLibrary.activeId === activeId, loaded };
        });
        assert.deepEqual(result, { expected: '甲甲甲乙新丁', after: '甲甲甲乙新丁', sameDoc: true, loaded: false });
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('公文备份导入保留正文、材料及版本，独立保存且不复用导出绑定', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const result = await page.evaluate(async () => {
            const oldId = officialWritingLibrary.activeId;
            const backup = { format: 'pivot-official-writing', version: 2, title: '恢复验收', state: {
                draft: '恢复的正文\n\n保留空行', source: '事实材料', artifactId: '123', meta: { cc: '各单位' },
                versions: [{ id: 'old', draft: '旧正文', source: '旧材料', name: '旧版本' }]
            } };
            const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
            await importOfficialWritingBackup(file);
            await window.Pivot.moduleApi('apps.officialWriting').flush();
            return { different: oldId !== officialWritingLibrary.activeId, draft: officialWritingState.draft, source: officialWritingState.source,
                cc: officialWritingState.meta.cc, artifactId: officialWritingState.artifactId,
                versionSource: resolveOfficialWritingVersionSource(officialWritingState.versions[0]) };
        });
        assert.deepEqual(result, { different: true, draft: '恢复的正文\n\n保留空行', source: '事实材料', cc: '各单位', artifactId: '', versionSource: '旧材料' });
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('公文材料异步读取期间切换文档，结果仍加入发起文档', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const result = await page.evaluate(async () => {
            const originalId = officialWritingLibrary.activeId;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            const pending = importOfficialWritingMaterialFiles([{ name: '材料.txt', size: 20, arrayBuffer: async () => { await gate; return new TextEncoder().encode('异步事实材料').buffer; } }]);
            createOfficialWritingDoc({ title: '异步读取后的新公文' });
            release(); await pending;
            return { original: officialWritingLibrary.docs.find(doc => doc.id === originalId).state.source, active: officialWritingState.source };
        });
        assert.match(result.original, /异步事实材料/);
        assert.equal(result.active, '');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('公文流式接口明确报告中断和 EOF，内联思考不进入可采纳正文', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const result = await page.evaluate(async () => {
            window.testApiOverride = async url => url.endsWith('/ai') ? new Response('data: {"choices":[{"delta":{"content":"<think>内部推理</think>部分正文"}}]}\n\ndata: {"error":{"message":"模型中断"}}\n\n') : null;
            const interrupted = await requestOfficialWritingAi({ mode: 'draft' }, { stream: true });
            window.testApiOverride = async url => url.endsWith('/ai') ? new Response('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n') : null;
            const earlyEnd = await requestOfficialWritingAi({ mode: 'draft' }, { stream: true });
            return { interrupted: { status: interrupted.status, content: interrupted.content, partial: interrupted.partial }, earlyEnd: earlyEnd.status };
        });
        assert.deepEqual(result, { interrupted: { status: 'error', content: '部分正文', partial: true }, earlyEnd: 'partial' });
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('截图标准附件编辑与四层级导出，原文不被格式化改写，标题可仅调整分行', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        await page.evaluate(() => {
            setOfficialWritingTextareaValue('draft', '关于年度检查工作的通知\n各单位：\n一、总体\n(一)目标\n1、工作\n(1)要求\n落实各项任务。\n示例局\n2026年11月4日');
            syncOfficialWritingStateFromInputs(); openOfficialWritingDrawer('elements');
        });
        await page.locator('#official-writing-add-attachment-btn').click();
        await page.getByLabel('附件 1 名称', { exact: true }).fill('检查反馈表。');
        await page.getByLabel('附件 1 正文', { exact: true }).fill('附件正文\n(1)核对结果');
        const result = await page.evaluate(() => {
            const first = buildOfficialWritingDocumentIr();
            officialWritingState.meta.titleBreaks = '关于年度检查\n工作的通知';
            const title = buildOfficialWritingDocumentIr();
            officialWritingState.meta.titleBreaks = '不一致的标题';
            const invalid = buildOfficialWritingDocumentIr();
            return { levels: first.ir.blocks.filter(block => block.type === 'heading').map(block => [block.level, block.text]),
                note: first.ir.blocks.find(block => block.style?.official_role === 'attachment_note').runs[0].text,
                labels: first.ir.blocks.filter(block => block.style?.official_role === 'attachment_label').map(block => block.runs[0].text),
                pages: first.ir.blocks.filter(block => block.type === 'page_break').length, title: title.ir.meta.title, invalid: invalid.error,
                draft: officialWritingState.draft, page: first.ir.meta.page };
        });
        assert.deepEqual(result.levels.slice(0, 4), [[1, '一、总体'], [2, '（一）目标'], [3, '1. 工作'], [4, '（1）要求']]);
        assert.equal(result.note, '附件：检查反馈表'); assert.deepEqual(result.labels, ['附件']); assert.equal(result.pages, 1);
        assert.equal(result.title, '关于年度检查\n工作的通知'); assert.match(result.invalid, /标题分行文字与正文标题不一致/);
        assert.ok(result.draft.includes('(一)目标'));
        assert.deepEqual(result.page.margin_mm, { top: 37, bottom: 35, left: 27, right: 27 });
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('模型列表延迟返回不会把已打开的公文切回列表或清空正文', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        await page.evaluate(async () => {
            window.Pivot.legacy.PivotAppModels = { refresh: () => new Promise(resolve => { window.releaseModels = resolve; }) };
            await showOfficialWritingApp();
            createOfficialWritingDoc({ title: '模型目录延迟验收' });
            setOfficialWritingTextareaValue('draft', '必须保留的正文'); syncOfficialWritingStateFromInputs();
            window.releaseModels();
        });
        assert.equal(await page.locator('#official-writing-draft-surface').isVisible(), true);
        assert.equal(await page.locator('#official-writing-draft').inputValue(), '必须保留的正文');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});

test('编辑静态预览统一空行间距，原稿已有空白行时不重复叠加', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const { page, errors } = await createOfficialWritingPage(browser);
        const source = '首行标题第二行标题\n\n\n各单位：\n正文末行内容\n\n附件：测试说明\n\n\n署名单位\n\n2026年11月4日';
        await page.evaluate(value => {
            setOfficialWritingTextareaValue('draft', value);
            document.getElementById('official-writing-meta-title-breaks').value = '首行标题\n第二行标题';
            syncOfficialWritingStateFromInputs();
        }, source);
        await page.locator('#official-writing-toggle-left-btn').focus();
        const gaps = await page.evaluate(() => {
            const surface = document.getElementById('official-writing-draft-surface');
            const block = value => [...surface.querySelectorAll('.official-writing-surface-line')].find(node => node.textContent.includes(value)).getBoundingClientRect();
            const title = block('首行标题'), recipient = block('各单位：'), body = block('正文末行内容'), attachment = block('附件：'), signer = block('署名单位'), date = block('2026年');
            return { title: recipient.top - title.bottom, attachment: attachment.top - body.bottom, signature: signer.top - attachment.bottom, date: date.top - signer.bottom };
        });
        for (const [name, expected] of Object.entries({ title: 28 * 4 / 3, attachment: 28 * 4 / 3, signature: 84 * 4 / 3, date: 0 })) {
            assert.ok(Math.abs(gaps[name] - expected) < 1, `${name} 实际间距 ${gaps[name]}，应为 ${expected}`);
        }
        assert.equal(await page.locator('#official-writing-draft').inputValue(), source);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
