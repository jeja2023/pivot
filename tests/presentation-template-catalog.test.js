'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readable, contrast, textBackground } = require('../client/chat/presentation-colors');
const { normalizePresentation, defaultPresentation } = require('../server/services/presentations/presentation-schema');
const { getBuiltInTemplate, listBuiltInTemplates } = require('../server/services/presentations/presentation-templates');
const { applyTemplateLayoutLayers } = require('../server/services/presentations/presentation-template-reflow');
const { runPresentationValidation } = require('../server/services/presentations/presentation-validation');
const { classify, runtimeTemplate } = require('../server/services/presentations/presentation-template-catalog');
const { normalize } = require('../server/services/presentations/master/contract');

test('通用用途与历史主题在同一目录中分类，历史模板版本和摘要保持可解析', () => {
    const templates = listBuiltInTemplates().map(classify);
    assert.equal(templates.filter(item => item.recommended).length, 3);
    assert.equal(templates.filter(item => item.legacyTheme).length, 2);
    for (const item of templates) { assert.ok(getBuiltInTemplate(item.id, item.version)); assert.equal(getBuiltInTemplate(item.id, item.version).snapshotDigest, item.snapshotDigest); }
    assert.ok(getBuiltInTemplate('executive-clean', 1));
    assert.equal(getBuiltInTemplate('executive-clean', 2).version, 2);
    assert.equal(getBuiltInTemplate('forest-green', 1).version, 1);
    assert.ok(getBuiltInTemplate('forest-green').version > 1);
    assert.ok(runtimeTemplate('master-style-consulting-decision'));
    assert.equal(runtimeTemplate('../../secrets'), null);
    assert.ok(!classify({ id: 'private', ownerType: 'user', sourceAvailable: true, sourceFormat: 'pivot' }).supportedEngines.includes('master'));
    assert.ok(classify({ id: 'unit', ownerType: 'user', sourceAvailable: true, definition: { importMetadata: { sourceFormat: 'pptx' } } }).supportedEngines.includes('master'));
});

test('新版内置模板所有明确实色背景上的文字槽位和装饰达到4.5对比度，旧版仍可原样读取', () => {
    for (const template of listBuiltInTemplates()) for (const layout of template.layouts) {
        const master = template.masters.find(item => item.id === layout.masterId);
        const slide = { background: master?.background || { fill: template.theme.colors.background }, elements: [...(master?.decorations || []), ...(layout.decorations || [])] };
        const text = [...slide.elements.filter(item => item.type === 'text'), ...(layout.placeholders || []).filter(item => item.kind === 'text').map(item => ({ ...item, zIndex: 10 }))];
        for (const item of text) assert.ok(contrast(item.style.color, textBackground(slide, item)) >= 4.5, template.id + ':' + layout.id + ':' + item.id);
    }
});

test('显式换主题后按实际底色修复文字颜色，普通保存与历史读取不改自定义颜色', () => {
    const template = getBuiltInTemplate('executive-clean'), old = defaultPresentation({ title: '颜色验收' });
    old.slides = [normalizePresentation({ slides: [{ id: 'cover', layoutId: 'cover', background: { fill: '#FFFFFF' }, elements: [
        { id: 'title', type: 'text', x: 80, y: 160, width: 800, height: 160, content: { text: '深色封面清晰标题' }, style: { fontSize: 42, color: '#243746' } },
        { id: 'subtitle', role: 'subtitle', type: 'text', x: 90, y: 450, width: 700, height: 80, content: { text: '保留全部文字' }, style: { fontSize: 26, color: '#DFEBE5' } }
    ] }] }).slides[0]];
    const original = JSON.stringify(old), saved = applyTemplateLayoutLayers(old, template, { normalizePresentation });
    assert.equal(saved.slides[0].elements.find(item => item.id === 'subtitle').style.color, '#DFEBE5');
    const changed = applyTemplateLayoutLayers(old, template, { recolor: true, normalizePresentation });
    for (const text of changed.slides[0].elements.filter(item => item.type === 'text')) assert.ok(contrast(text.style.color, textBackground(changed.slides[0], text)) >= 4.5, text.id);
    const light = JSON.parse(JSON.stringify(template)); light.masters.forEach(master => { master.background.fill = '#FFFFFF'; }); light.layouts.forEach(layout => layout.placeholders.forEach(slot => { if (slot.style) slot.style.color = '#243746'; }));
    const lightCover = applyTemplateLayoutLayers(changed, light, { recolor: true, normalizePresentation });
    assert.equal(lightCover.slides[0].background.fill, '#FFFFFF');
    for (const text of lightCover.slides[0].elements.filter(item => item.type === 'text')) assert.ok(contrast(text.style.color, textBackground(lightCover.slides[0], text)) >= 4.5);
    assert.equal(changed.slides[0].elements.find(item => item.id === 'title').content.text, '深色封面清晰标题');
    assert.equal(JSON.stringify(old), original);
    assert.equal(readable('#FFFFFF', '#FFFFFF'), '#172B3A');
});

test('对比度检查考虑文字下面的实色卡片，拒绝白字白底且不误报白字深色卡片', () => {
    const content = normalizePresentation({ slides: [{ id: 'slide', background: { fill: '#FFFFFF' }, elements: [
        { id: 'card', type: 'shape', shapeType: 'rect', x: 80, y: 100, width: 600, height: 300, zIndex: 1, style: { fill: '#17324D', opacity: 1 } },
        { id: 'text', type: 'text', x: 100, y: 140, width: 500, height: 100, zIndex: 10, content: { text: '清晰文字' }, style: { color: '#FFFFFF', fontSize: 24 } },
        { id: 'bad', type: 'text', x: 800, y: 140, width: 300, height: 100, zIndex: 10, content: { text: '白底白字' }, style: { color: '#FFFFFF', fontSize: 24 } }
    ] }] });
    const issues = runPresentationValidation(content).issues.filter(item => item.code === 'LOW_CONTRAST');
    assert.deepEqual(issues.map(item => item.elementId), ['bad']);
});

test('完整引擎模板合同固定目录与版本，拒绝模板和原稿来源混用', () => {
    const request = { title: '模板制作', instruction: '根据授权材料生成汇报。', modelId: '1' };
    assert.equal(normalize({ ...request, template: { type: 'runtime', id: 'master-style-consulting-decision' } }).template.id, 'master-style-consulting-decision');
    assert.equal(normalize({ ...request, operation: 'edit_native', template: { type: 'organization', id: 'unit-template', version: 2 } }).template.version, 2);
    assert.throws(() => normalize({ ...request, template: { type: 'runtime', id: '../../secrets' } }), /固定发行包/);
    assert.throws(() => normalize({ ...request, profile: 'quick', template: { type: 'runtime', id: 'master-style-consulting-decision' } }), /流程/);
    assert.throws(() => normalize({ ...request, operation: 'edit_native', template: { type: 'organization', id: 'unit-template', version: 0 } }), /版本/);
    assert.throws(() => normalize({ ...request, sourceAssetId: '12', template: { type: 'runtime', id: 'master-style-consulting-decision' } }), /流程/);
});

test('PPT模板弹窗点击外部遮罩层不关闭，仅点击关闭按钮关闭（含数据分析已挂载场景）', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');

    const byId = new Map();
    const docListeners = {};
    const makeClassList = (initial = []) => {
        const set = new Set(initial);
        return {
            add: (...cls) => cls.forEach(c => set.add(c)),
            remove: (...cls) => cls.forEach(c => set.delete(c)),
            toggle: (c, force) => {
                if (force === undefined) set.has(c) ? set.delete(c) : set.add(c);
                else if (force) set.add(c);
                else set.delete(c);
            },
            contains: c => set.has(c)
        };
    };
    const makeNode = (tag, initialClasses = []) => {
        const listeners = {};
        let id = '';
        const node = {
            tagName: String(tag || 'div').toUpperCase(),
            classList: makeClassList(initialClasses),
            set className(val) { this.classList = makeClassList(String(val || '').split(/\s+/).filter(Boolean)); },
            get className() { return ''; },
            set id(val) { id = val; if (id) byId.set(id, this); },
            get id() { return id; },
            dataset: {},
            children: [],
            options: [],
            textContent: '',
            append(...items) { this.children.push(...items); },
            appendChild(item) { this.children.push(item); return item; },
            replaceChildren(...items) { this.children = [...items]; },
            setAttribute() {},
            toggleAttribute() {},
            querySelectorAll() { return []; },
            querySelector() { return null; },
            closest() { return null; },
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
            dispatchClick(target = this) {
                let stopped = false;
                const event = { target, preventDefault() {}, stopPropagation() { stopped = true; } };
                for (const fn of listeners.click || []) fn(event);
                if (!stopped) for (const fn of docListeners.click || []) fn(event);
            }
        };
        return node;
    };

    const daPanel = makeNode('div');
    daPanel.id = 'data-analysis-governance-panel';
    const daCalcModal = makeNode('div', ['modal-overlay', 'data-analysis-modal-overlay']);
    daCalcModal.id = 'data-analysis-calc-modal';

    const modules = {};
    const document = {
        body: makeNode('body'),
        getElementById: id => byId.get(id) || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: tag => makeNode(tag),
        createElementNS: (_ns, tag) => makeNode(tag),
        addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); }
    };
    const windowObj = {
        Pivot: {
            legacy: { PivotDataAnalysis: { state: {}, renderActiveTable() {} } },
            moduleApi: name => modules[name],
            exposeModule: (name, api) => { modules[name] = api; }
        }
    };
    const context = {
        window: windowObj,
        document,
        PivotSafeHtml: { setHtml(el, value) { el.innerHTML = value; } },
        Option: function (text, value) { return { text, value }; },
        Event: globalThis.Event,
        setTimeout
    };

    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/extra-panels.js'), 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/apps-workbench-presentation-catalog.js'), 'utf8'), context);

    windowObj.Pivot.legacy.PivotDataAnalysis.mountDataAnalysisExtraPanels();
    modules['apps.presentations.catalog'].bind({}, {
        requestJson: async () => ({ templates: [], engine: { enabled: false }, canManageTemplates: false }),
        openCreateModal() {},
        toast() {}
    });

    await modules['apps.presentations.catalog'].open('all');
    const catalogModal = byId.get('presentation-catalog-modal');
    assert.equal(catalogModal.classList.contains('hidden'), false);

    // 点击模板弹窗外部遮罩层不应关闭弹窗
    catalogModal.dispatchClick(catalogModal);
    assert.equal(catalogModal.classList.contains('hidden'), false);

    // 点击数据分析自身遮罩层仍可正常关闭
    daCalcModal.dispatchClick(daCalcModal);
    assert.equal(daCalcModal.classList.contains('hidden'), true);

    // 仅点击模板弹窗关闭按钮才能关闭
    const closeBtn = catalogModal.children[0].children[0].children[0].children[1];
    assert.equal(closeBtn.textContent, '关闭');
    closeBtn.dispatchClick(closeBtn);
    assert.equal(catalogModal.classList.contains('hidden'), true);
});
