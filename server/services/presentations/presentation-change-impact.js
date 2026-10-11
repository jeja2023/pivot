'use strict';

const { canonicalJson } = require('../canonical-json');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function elementLabel(element = {}) {
    if (element.type === 'text') return String(element.content?.text || '文本').slice(0, 80);
    if (element.type === 'chart') return String(element.title || '图表').slice(0, 80);
    if (element.type === 'table') return String(element.columns?.join(' / ') || '表格').slice(0, 80);
    if (element.type === 'image') return String(element.alt || '图片').slice(0, 80);
    return String(element.type || '元素');
}

function changedFields(before = {}, after = {}) {
    const fields = {
        content: '文字内容',
        x: '横向位置', y: '纵向位置', width: '宽度', height: '高度', rotation: '旋转角度', zIndex: '层级',
        style: '视觉样式', visible: '显示状态', sourceRefs: '来源引用',
        columns: '表格列', rows: '表格数据', chartType: '图表类型', title: '图表标题', data: '图表数据', options: '图表选项',
        assetRef: '素材引用', fit: '图片适应方式', opacity: '透明度', items: '图示节点', shapeType: '形状类型'
    };
    return Object.entries(fields).flatMap(([key, label]) => canonicalJson(before[key] ?? null) === canonicalJson(after[key] ?? null) ? [] : [label]);
}

function mergeLockedElements(currentSlide = {}, proposedSlide = {}) {
    const current = clone(currentSlide);
    const proposed = clone(proposedSlide);
    const existing = new Map((proposed.elements || []).map(item => [item.id, item]));
    const protectedIds = [];
    (current.elements || []).filter(item => item.locked).forEach(item => {
        protectedIds.push(item.id);
        existing.set(item.id, clone(item));
    });
    const elements = [...existing.values()]
        .sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    return {
        ...proposed,
        id: current.id || proposed.id,
        index: Number.isInteger(current.index) ? current.index : proposed.index,
        review: current.review || proposed.review,
        sourceRefs: [...new Set([...(current.sourceRefs || []), ...(proposed.sourceRefs || [])])],
        elements,
        protectedLockedElementIds: protectedIds
    };
}

function buildSlideChangeImpact(currentSlide = {}, proposedSlide = {}) {
    const before = new Map((currentSlide.elements || []).map(item => [item.id, item]));
    const after = new Map((proposedSlide.elements || []).map(item => [item.id, item]));
    const changes = [];
    before.forEach((element, id) => {
        const next = after.get(id);
        if (!next) {
            changes.push({ kind: 'removed', elementId: id, elementType: element.type, before: elementLabel(element), after: '', fields: [] });
            return;
        }
        const fields = changedFields(element, next);
        if (fields.length) changes.push({ kind: 'updated', elementId: id, elementType: next.type, before: elementLabel(element), after: elementLabel(next), fields });
    });
    after.forEach((element, id) => {
        if (!before.has(id)) changes.push({ kind: 'added', elementId: id, elementType: element.type, before: '', after: elementLabel(element), fields: [] });
    });
    const counts = {
        added: changes.filter(item => item.kind === 'added').length,
        updated: changes.filter(item => item.kind === 'updated').length,
        removed: changes.filter(item => item.kind === 'removed').length,
        protectedLocked: (proposedSlide.protectedLockedElementIds || []).length
    };
    return {
        scope: 'current_slide',
        slideId: currentSlide.id || proposedSlide.id || '',
        counts,
        changes: changes.slice(0, 100),
        summary: `当前页将新增 ${counts.added} 项、修改 ${counts.updated} 项、移除 ${counts.removed} 项；已保留 ${counts.protectedLocked} 项锁定元素。`
    };
}

module.exports = { buildSlideChangeImpact, mergeLockedElements };
