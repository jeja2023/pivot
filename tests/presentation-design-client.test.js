'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function moduleUnderTest() {
    let api;
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentation-design.js', 'utf8'), {
        document: { getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        window: { Pivot: { moduleApi: () => null, exposeModule: (_name, value) => { api = value; } } }
    });
    return api;
}

test('视觉复核明确单页与未复核状态，内容或版本变化后不沿用通过提示', () => {
    const api = moduleUnderTest();
    const state = { editRevision: 4, active: { version: 2, validation: { visualReview: { status: 'passed', message: '第3页已通过', localRevision: 4, localVersion: 2 } } } };
    assert.equal(api.reviewMessage(state), '第3页已通过');
    state.editRevision++;
    assert.match(api.reviewMessage(state), /文稿已变化/);
    state.editRevision = 4; state.active.version = 3;
    assert.match(api.reviewMessage(state), /重新复核/);
    state.active.validation = {};
    assert.match(api.reviewMessage(state), /尚未/);
});

test('迟到的视觉检查响应不会覆盖已切换的文稿，模型不可用保留明确状态', async () => {
    const api = moduleUnderTest();
    const state = { editRevision: 0, active: { id: 'first', version: 1, validation: { issues: [] } }, selectedSlideId: 's1' };
    let resolve, rendered = false;
    const helpers = {
        requirePresentationAiModel: () => 'model', beginAiRequest: () => ({}), endAiRequest() {}, saveActive: async () => {},
        activeContent: () => ({ slides: [{ id: 's1' }] }), aiJsonOptions: value => value,
        requestJson: () => new Promise(done => { resolve = done; }), switchPanel() {}, renderIssues: () => { rendered = true; }, toast() {}, isAiAbort: () => false
    };
    const pending = api.runVisualReview(state, helpers);
    state.active = { id: 'second', version: 1, validation: { issues: [] } };
    resolve({ review: { status: 'passed', message: '已通过', issues: [], slideId: 's1' } });
    await pending;
    assert.equal(rendered, false); assert.equal(state.active.validation.visualReview, undefined);
    helpers.requestJson = async () => ({ review: { status: 'unavailable', message: '尚未进行视觉复核：模型不可用', issues: [], slideId: 's1' } });
    await api.runVisualReview(state, helpers);
    assert.equal(state.active.validation.visualReview.status, 'unavailable');
    assert.match(api.reviewMessage(state), /模型不可用/);
});

test('同一大纲重试沿用草稿，修改大纲使用新草稿标识', async () => {
    let api;
    const button = { classList: { add() {} } };
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentations-generation.js', 'utf8'), {
        document: { getElementById: () => button },
        window: { Pivot: { exposeModule: (_name, value) => { api = value; } } },
        crypto: require('node:crypto').webcrypto
    });
    const state = { pendingCreate: { topic: '项目报告' } }, submitted = [], opened = [], notices = [];
    let conflict = false;
    const { generateSlides } = api.create(state, {
        requestJson: async (url, options) => {
            assert.match(url, /\/ai\/slides$/);
            const { body, controller } = options;
            submitted.push(body.draftId);
            if (conflict) throw Object.assign(new Error('旧草稿对应另一份大纲'), { code: 'PRESENTATION_GENERATION_PLAN_CHANGED' });
            controller.abort();
            throw controller.signal.reason;
        },
        beginAiRequest: () => new AbortController(), endAiRequest() {}, aiJsonOptions: (body, controller) => ({ body, controller }),
        isAiAbort: (_error, controller) => controller.signal.aborted, openPresentation: id => opened.push(id),
        toast: message => notices.push(message),
    });
    const original = { title: '项目报告', slides: [{ title: '概况' }] };
    const modified = { ...original, slides: [{ title: '调整后的概况' }] };
    await generateSlides(original);
    await generateSlides(original);
    await generateSlides(modified);
    assert.equal(submitted[0], submitted[1]);
    assert.notEqual(submitted[1], submitted[2]);
    conflict = true;
    await generateSlides(modified);
    assert.equal(state.pendingCreate.draftId, undefined);
    assert.match(notices.at(-1), /再次点击“生成页面”/);
    assert.deepEqual(opened, []);
});

test('改写确认期间有新编辑时保留当前页，只有未变更的页面可接受建议', async () => {
    let api, editBeforeConfirm = true, applied = 0;
    const state = { activeEpoch: 1, active: { id: 'doc', content: { title: '报告', slides: [{ id: 's1', text: '原文' }] } } };
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentations-generation.js', 'utf8'), {
        document: { getElementById: () => ({ value: '整理要点' }) },
        window: { Pivot: { exposeModule: (_name, value) => { api = value; }, legacy: { showConfirm: async () => {
            if (editBeforeConfirm) state.active.content.slides[0].text = '用户刚修改';
            return true;
        } } } }
    });
    const { rewriteCurrentSlide } = api.create(state, {
        beginAiRequest: () => new AbortController(), endAiRequest() {}, aiJsonOptions: body => body,
        activeSlide: () => state.active.content.slides[0], canEdit: () => true, flush: async () => true, requireModel: () => '1',
        requestJson: async (_url, body) => {
            assert.equal(body.slide.id, 's1');
            return { proposal: { presentation: { slides: [{ id: 'proposal', text: '模型建议' }] } } };
        },
        isAiAbort: () => false, formatChangeImpact: () => '', recordHistory: () => { applied++; }, renderEditor() {}, toast() {}
    });
    await rewriteCurrentSlide();
    assert.equal(state.active.content.slides[0].text, '用户刚修改');
    assert.equal(applied, 0);
    editBeforeConfirm = false;
    await rewriteCurrentSlide();
    assert.equal(state.active.content.slides[0].text, '模型建议');
    assert.equal(state.active.content.slides[0].id, 's1');
    assert.equal(applied, 1);
});

test('交付检查摘要展示结构化卡片，点击查看整稿检查结果打开报告并可定位问题页', async () => {
    const createNode = tag => {
        const listeners = new Map();
        const node = {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            type: '',
            childNodes: [],
            attributes: {},
            classList: {
                toggle(name, force) {
                    const set = new Set(node.className.split(/\s+/).filter(Boolean));
                    if (force === undefined ? !set.has(name) : force) set.add(name); else set.delete(name);
                    node.className = Array.from(set).join(' ');
                }
            },
            setAttribute(k, v) { node.attributes[k] = v; },
            removeAttribute(k) { delete node.attributes[k]; },
            appendChild(child) { node.childNodes.push(child); child.parentNode = node; return child; },
            append(...children) { children.forEach(c => node.appendChild(c)); },
            replaceChildren(...children) { node.childNodes = []; node.append(...children); },
            remove() { if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(c => c !== node); },
            addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
            click() { (listeners.get('click') || []).forEach(fn => fn({ target: node })); },
            querySelectorAll(selector) {
                const cls = selector.startsWith('.') ? selector.slice(1) : '';
                const matched = [];
                const walk = current => {
                    for (const child of current.childNodes || []) {
                        if (cls && child.className.split(/\s+/).includes(cls)) matched.push(child);
                        walk(child);
                    }
                };
                walk(node);
                return matched;
            }
        };
        return node;
    };
    const findAll = (root, predicate, out = []) => {
        if (predicate(root)) out.push(root);
        for (const child of root.childNodes || []) findAll(child, predicate, out);
        return out;
    };
    const statusPanel = createNode('div'); statusPanel.id = 'presentation-production-task-status';
    const body = createNode('body');
    const docListeners = new Map();
    const doc = {
        body,
        createElement: createNode,
        getElementById(id) {
            if (id === 'presentation-production-task-status') return statusPanel;
            return findAll(body, n => n.id === id)[0] || null;
        },
        addEventListener(type, fn) { docListeners.set(type, fn); },
        removeEventListener(type) { docListeners.delete(type); }
    };
    let api;
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentation-design.js', 'utf8'), {
        document: doc,
        window: { Pivot: { legacy: { currentUser: { id: 1 } }, moduleApi: () => null, exposeModule: (_name, value) => { api = value; } } }
    });
    const state = {
        editRevision: 2,
        selectedSlideId: 's1',
        selectedElementId: '',
        active: { id: 'doc1', version: 1, content: { slides: [{ id: 's1' }, { id: 's2' }] }, validation: { issues: [] } }
    };
    const calls = { switched: [], rendered: 0, issuesRendered: 0 };
    await api.restoreDeckTask(state, {
        requestJson: async () => ({
            task: {
                id: 't1',
                mode: 'production',
                status: 'completed',
                stale: false,
                result: {
                    mode: 'production',
                    message: '已检查2页及最终PPTX：1项阻断、1项建议。视觉与Office检查范围见报告。',
                    validation: { issues: [] },
                    productionReview: {
                        status: 'blocked',
                        checkedAt: '2026-11-20T12:00:00.000Z',
                        scope: '结构、真实字体容量、素材和最终文件原生对象',
                        summary: { slides: 2, blocking: 1, warnings: 1, minimumBodyFontPt: 18 },
                        checks: {
                            layout: { status: 'blocked', textMeasurement: 'measured' },
                            native: { status: 'passed' },
                            visual: { status: 'not_checked', checkedSlides: 0 },
                            office: { status: 'not_checked', message: '尚未针对最终文件执行独立Office渲染。' },
                            assets: []
                        },
                        issues: [
                            { level: 'blocking', code: 'TEXT_OVERFLOW', slideId: 's2', elementId: 'el2', message: '实际字体测量发现文字放不下。', suggestion: '请调整布局或拆页。' },
                            { level: 'warning', code: 'PRODUCTION_READABILITY', slideId: 's1', elementId: 'el1', message: '字号偏小。', suggestion: '请调大字号。' }
                        ]
                    }
                }
            }
        }),
        renderIssues: () => { calls.issuesRendered++; },
        switchPanel: panel => { calls.switched.push(panel); },
        renderEditor: () => { calls.rendered++; }
    });
    assert.equal(calls.issuesRendered, 1);
    const viewBtn = findAll(statusPanel, n => n.tagName === 'BUTTON' && n.textContent === '查看整稿检查结果')[0];
    assert.ok(viewBtn, '应渲染查看整稿检查结果按钮');
    viewBtn.click();
    const modal = doc.getElementById('presentation-deck-report-modal');
    assert.ok(modal, '点击后应打开整稿检查结果弹窗');
    const locateBtns = findAll(modal, n => n.tagName === 'BUTTON' && n.textContent === '定位该页');
    assert.equal(locateBtns.length, 2);
    locateBtns[0].click();
    assert.equal(state.selectedSlideId, 's2');
    assert.equal(state.selectedElementId, 'el2');
    assert.equal(calls.rendered, 1);
    assert.deepEqual(calls.switched, ['issues']);
    assert.equal(doc.getElementById('presentation-deck-report-modal'), null, '定位后应自动关闭报告弹窗');
});
