'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('../canonical-json');
const colors = require('../../../client/chat/presentation-colors');

function improve(template) {
    const next = JSON.parse(JSON.stringify(template));
    let changed = false;
    function text(item, surface) {
        if (!item.style?.color || surface.background?.imageAssetRef) return;
        const color = colors.readable(colors.textBackground(surface, { ...item, zIndex: item.zIndex ?? 10 }), item.style.color);
        if (color !== item.style.color) { item.style.color = color; changed = true; }
    }
    for (const master of next.masters || []) {
        const surface = { background: master.background || { fill: next.theme.colors.background }, elements: master.decorations || [] };
        for (const item of surface.elements.filter(item => item.type === 'text')) text(item, surface);
    }
    for (const layout of next.layouts || []) {
        let master = (next.masters || []).find(item => item.id === layout.masterId);
        const surface = { background: master?.background || { fill: next.theme.colors.background }, elements: [...(master?.decorations || []), ...(layout.decorations || [])] };
        if (master && (master.decorations || []).some(item => item.type === 'text' && colors.contrast(item.style?.color, colors.textBackground(surface, item)) < 4.5)) {
            master = JSON.parse(JSON.stringify(master)); master.id += '_readable_' + layout.id;
            for (const item of master.decorations.filter(item => item.type === 'text')) text(item, surface);
            next.masters.push(master); layout.masterId = master.id; changed = true;
        }
        for (const item of layout.decorations || []) if (item.type === 'text') text(item, surface);
        for (const item of layout.placeholders || []) if (item.kind === 'text') text(item, surface);
    }
    if (!changed) return template;
    next.version = Number(template.version) + 1;
    next.snapshotDigest = crypto.createHash('sha256').update(canonicalJson({ id: next.id, version: next.version, theme: next.theme, masters: next.masters, layouts: next.layouts })).digest('hex');
    return next;
}
function registry(previousTemplates) {
    const templates = previousTemplates.map(improve), clone = value => JSON.parse(JSON.stringify(value));
    return {
        listBuiltInTemplates: () => templates.map(clone),
        getBuiltInTemplate(id, version) {
            id = String(id || '').trim();
            if (Number(version) === 1) {
                const original = require('./presentation-design-templates').listDesignTemplates().find(item => item.id === id);
                if (original) return clone(original);
            }
            const previous = version !== undefined ? previousTemplates.find(item => item.id === id && Number(item.version) === Number(version)) : null;
            if (previous) return clone(previous);
            const template = templates.find(item => item.id === id);
            return template && (version === undefined || Number(version) === Number(template.version)) ? clone(template) : null;
        }
    };
}
module.exports = { registry };
