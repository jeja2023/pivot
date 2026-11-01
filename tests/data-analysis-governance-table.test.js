/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('字段治理数据表格与表单项布局规范验证', () => {
    const jsPath = path.resolve(__dirname, '../client/chat/data-analysis/governance.js');
    const cssPath = path.resolve(__dirname, '../client/chat/styles/workspaces/apps/data-analysis-governance.css');

    const jsContent = fs.readFileSync(jsPath, 'utf8');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // 1. JS 结构中包含专属的表格包裹层与列分配
    assert.match(jsContent, /data-analysis-governance-table-wrap/);
    assert.match(jsContent, /data-analysis-gov-col-field/);
    assert.match(jsContent, /data-analysis-gov-col-role/);
    assert.match(jsContent, /data-analysis-gov-col-format/);

    // 2. 角色列使用容器包裹维度与指标复选框
    assert.match(jsContent, /data-analysis-governance-role-cell/);
    assert.match(jsContent, /data-governance-input="isDimension"/);
    assert.match(jsContent, /data-governance-input="isMetric"/);

    // 3. 单位与日期格式列使用双输入项 flex 容器包裹
    assert.match(jsContent, /data-analysis-governance-dual-input/);
    assert.match(jsContent, /data-governance-input="unit"/);
    assert.match(jsContent, /data-governance-input="dateFormat"/);

    // 4. CSS 规则排除 input[type="checkbox"] 避免复选框被拉伸至 90px
    assert.match(cssContent, /\.data-analysis-governance-table input:not\(\[type="checkbox"\]\)/);
    assert.match(cssContent, /\.data-analysis-governance-table input\[type="checkbox"\]\s*\{[^}]*width:\s*15px\s*!important/);

    // 5. 双输入框 flex 分配
    assert.match(cssContent, /\.data-analysis-governance-dual-input\s*\{[^}]*display:\s*flex/);
    assert.match(cssContent, /\.data-analysis-governance-dual-input input\s*\{[^}]*flex:\s*1 1 50%/);

    // 6. 第一列字段单行不换行排版
    assert.match(jsContent, /data-analysis-gov-field-cell/);
    assert.match(cssContent, /\.data-analysis-gov-field-cell\s*\{[^}]*display:\s*inline-flex/);
    assert.match(cssContent, /\.data-analysis-gov-field-cell\s*\{[^}]*white-space:\s*nowrap/);

    // 7. 表格尺寸与表单项间距消除（避免 form-input 继承 15px 下边距）
    assert.match(cssContent, /\.data-analysis-governance-table\s*\{[^}]*min-width:\s*1150px/);
    assert.match(cssContent, /\.data-analysis-governance-table input:not\(\[type="checkbox"\]\)[^}]*margin:\s*0\s*!important/);
    assert.match(cssContent, /\.data-analysis-governance-table td label[^}]*flex-shrink:\s*0\s*!important/);
});

test('真实浏览器验证字段治理表格各列完整显示与单行不换行', async () => {
    const { chromium } = require(path.resolve(__dirname, '../node_modules/playwright'));
    const shellCss = fs.readFileSync(path.resolve(__dirname, '../client/chat/chat.shell.css'), 'utf8');
    const appsCss = fs.readFileSync(path.resolve(__dirname, '../client/chat/chat.workspace.apps.css'), 'utf8');

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
        const html = `<!DOCTYPE html><html><head><style>${shellCss}\n${appsCss}</style></head>
        <body style="padding: 20px;">
            <div class="table-container data-analysis-governance-table-wrap">
                <table class="data-table compact-table data-analysis-governance-table">
                    <colgroup>
                        <col class="data-analysis-gov-col-field">
                        <col class="data-analysis-gov-col-name">
                        <col class="data-analysis-gov-col-type">
                        <col class="data-analysis-gov-col-role">
                        <col class="data-analysis-gov-col-format">
                        <col class="data-analysis-gov-col-sensitivity">
                        <col class="data-analysis-gov-col-def">
                    </colgroup>
                    <thead>
                        <tr>
                            <th class="data-analysis-gov-th-field">字段</th>
                            <th class="data-analysis-gov-th-name">显示名称</th>
                            <th class="data-analysis-gov-th-type">业务类型</th>
                            <th class="data-analysis-gov-th-role">角色</th>
                            <th class="data-analysis-gov-th-format">单位/日期格式</th>
                            <th class="data-analysis-gov-th-sensitivity">敏感级别</th>
                            <th class="data-analysis-gov-th-def">业务定义</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr data-analysis-governance-field="c_1">
                            <td><div class="data-analysis-gov-field-cell"><code class="data-analysis-gov-field-code">c_1</code><span class="data-analysis-field-source" title="时间">时间</span></div></td>
                            <td><input class="form-input" data-governance-input="displayName" value="时间"></td>
                            <td><select class="form-input" data-governance-input="logicalType"><option value="auto">自动识别</option></select></td>
                            <td><div class="data-analysis-governance-role-cell"><label class="data-analysis-governance-checkbox-label"><input type="checkbox" data-governance-input="isDimension" checked> 维度</label><label class="data-analysis-governance-checkbox-label"><input type="checkbox" data-governance-input="isMetric"> 指标</label></div></td>
                            <td><div class="data-analysis-governance-dual-input"><input class="form-input data-analysis-gov-input-unit" data-governance-input="unit" value="" placeholder="单位"><input class="form-input data-analysis-gov-input-date" data-governance-input="dateFormat" value="" placeholder="日期格式"></div></td>
                            <td><select class="form-input" data-governance-input="sensitivity"><option value="internal">内部</option></select></td>
                            <td><input class="form-input" data-governance-input="businessDefinition" value="" placeholder="业务含义与口径"></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </body></html>`;

        await page.setContent(html);

        // 1. 第一列字段单行不换行，且高度紧凑
        const fieldCell = await page.$eval('.data-analysis-gov-field-cell', el => ({
            height: el.getBoundingClientRect().height,
            codeDisplay: window.getComputedStyle(el.querySelector('code')).display,
            spanDisplay: window.getComputedStyle(el.querySelector('span')).display
        }));
        assert.ok(fieldCell.height < 25, `第一列高度应紧凑单行，实际为 ${fieldCell.height}`);

        // 2. 角色列“维度”与“指标”均完整可见且不换行
        const roleLabels = await page.$$eval('.data-analysis-governance-role-cell label', els => els.map(el => ({
            text: el.innerText.trim(),
            width: el.getBoundingClientRect().width,
            scrollWidth: el.scrollWidth
        })));
        assert.equal(roleLabels.length, 2);
        assert.equal(roleLabels[0].text, '维度');
        assert.equal(roleLabels[1].text, '指标');
        assert.ok(roleLabels[0].width >= 40, '“维度”复选框标签宽度正常');
        assert.ok(roleLabels[1].width >= 40, '“指标”复选框标签宽度正常');

        // 3. 双输入项“单位”和“日期格式”均完整分配，且消除了 15px 的 margin-bottom
        const inputs = await page.$$eval('.data-analysis-governance-dual-input input', els => els.map(el => ({
            placeholder: el.placeholder,
            width: el.getBoundingClientRect().width,
            marginBottom: window.getComputedStyle(el).marginBottom
        })));
        assert.equal(inputs.length, 2);
        assert.equal(inputs[0].placeholder, '单位');
        assert.equal(inputs[1].placeholder, '日期格式');
        assert.ok(inputs[0].width >= 80, `“单位”输入框宽度充足（实际 ${inputs[0].width}px）`);
        assert.ok(inputs[1].width >= 80, `“日期格式”输入框宽度充足（实际 ${inputs[1].width}px）`);
        assert.equal(inputs[0].marginBottom, '0px');
        assert.equal(inputs[1].marginBottom, '0px');

        // 4. 整行高度紧凑在 45px 以内
        const rowHeight = await page.$eval('tbody tr', el => el.getBoundingClientRect().height);
        assert.ok(rowHeight <= 45, `表格行高应在 45px 内，实际为 ${rowHeight}px`);
    } finally {
        await browser.close();
    }
});

test('规模化管道与指标口径自动同步治理数据集字段契约', () => {
    const scaleJsPath = path.resolve(__dirname, '../client/chat/data-analysis/scalability.js');
    const govJsPath = path.resolve(__dirname, '../client/chat/data-analysis/governance.js');
    const semanticJsPath = path.resolve(__dirname, '../client/chat/data-analysis/semantic-models.js');

    const scaleJs = fs.readFileSync(scaleJsPath, 'utf8');
    const govJs = fs.readFileSync(govJsPath, 'utf8');
    const semanticJs = fs.readFileSync(semanticJsPath, 'utf8');

    // 1. scalability options 函数支持对象同时具备 key/id 与 name/displayName 属性
    assert.match(scaleJs, /item\.key\s*\?\?\s*item\.id/);
    assert.match(scaleJs, /item\.name\s*\?\?\s*item\.displayName/);

    // 2. scalability loadScalability 立即执行 renderScalability
    assert.match(scaleJs, /state\.scalabilityDatasetId\s*=\s*id;\s*renderScalability\(\);/);

    // 3. governance dataset 切换时同步触发 loadScalability 与 loadSemanticModels
    assert.match(govJs, /app\.loadScalability\?\.\(datasetId,\s*\{\s*silent:\s*true\s*\}\)/);
    assert.match(govJs, /app\.loadSemanticModels\?\.\(\{\s*silent:\s*true\s*\}\)/);

    // 4. 按钮点击时触发实时加载与渲染
    assert.match(scaleJs, /#data-analysis-open-scale-modal/);
    assert.match(semanticJs, /#data-analysis-open-metric-modal/);
});

