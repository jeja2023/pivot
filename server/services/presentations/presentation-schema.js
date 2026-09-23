'use strict';

/**
 * 演示文稿 IR 1.0 契约。
 *
 * 该文件是 PPT 编辑器、AI 和导出器之间唯一允许交换的文稿格式。它刻意不
 * 接受 HTML、任意 CSS、外部 URL 或 data URI，以保证文稿可审计、可复现，
 * 并且不会把浏览器输入直接变成服务端渲染指令。
 */
const crypto = require('crypto');
const { canonicalJson } = require('../canonical-json');
const { readTypedEnv } = require('../../config/env-registry');

const PRESENTATION_IR_VERSION = '1.0';
const ASPECT_RATIOS = Object.freeze({
    '16:9': Object.freeze({ width: 1280, height: 720 }),
    '4:3': Object.freeze({ width: 960, height: 720 })
});
const ELEMENT_TYPES = Object.freeze(['text', 'image', 'shape', 'table', 'chart', 'media', 'diagram', 'attachment']);
const MEDIA_TYPES = Object.freeze(['audio', 'video']);
const TRANSITION_TYPES = Object.freeze(['none', 'fade', 'push', 'wipe', 'split', 'cover', 'uncover']);
const DIAGRAM_TYPES = Object.freeze(['process', 'cycle', 'hierarchy', 'relationship']);
const ANIMATION_TYPES = Object.freeze(['none', 'fade', 'zoom', 'wipe', 'fly']);
const CHART_TYPES = Object.freeze(['bar', 'line', 'area', 'pie']);
const SHAPE_TYPES = Object.freeze(['rect', 'roundRect', 'ellipse', 'line']);
const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);
const V_ALIGNMENTS = Object.freeze(['top', 'middle', 'bottom']);
const MAX_SLIDES = 100;
const MAX_ELEMENTS_PER_SLIDE = 100;
const MAX_TEXT_LENGTH = 16000;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_CHART_ROWS = 500;
const MAX_SOURCES = 500;
const MAX_DOCUMENT_BYTES = readTypedEnv('PIVOT_PRESENTATION_MAX_BYTES');
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const CAS_REF_PATTERN = /^artifact-cas:\/\/[0-9a-f]{16,64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function presentationError(message, status = 400, code = 'PRESENTATION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeId(value, label = '标识') {
    const id = String(value || '').trim();
    if (!ID_PATTERN.test(id)) throw presentationError(`${label}无效。`, 400, 'PRESENTATION_ID_INVALID');
    return id;
}

function normalizeBoundedText(value, fallback, maxLength, label, { trim = true, allowEmpty = false } = {}) {
    let text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (trim) text = text.trim();
    if (!text && !allowEmpty) text = String(fallback || '').trim();
    if (text.length > maxLength) throw presentationError(`${label}超过长度上限。`, 413, 'PRESENTATION_TEXT_TOO_LARGE');
    return text;
}

function normalizeNumber(value, fallback, min, max, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (number < min || number > max) throw presentationError(`${label}超出允许范围。`, 400, 'PRESENTATION_NUMBER_INVALID');
    return Math.round(number * 100) / 100;
}

function normalizeColor(value, fallback = '') {
    const color = String(value ?? fallback).trim();
    if (!color) return '';
    if (!COLOR_PATTERN.test(color)) throw presentationError('颜色必须使用 #RRGGBB 格式。', 400, 'PRESENTATION_COLOR_INVALID');
    return color.toUpperCase();
}

function normalizeBoolean(value, fallback = false) {
    return value === undefined ? fallback : Boolean(value);
}

function normalizeStringArray(value, maxItems, maxLength, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw presentationError(`${label}必须是数组。`);
    if (value.length > maxItems) throw presentationError(`${label}数量超过上限。`, 413, 'PRESENTATION_ARRAY_TOO_LARGE');
    return value.map(item => normalizeBoundedText(item, '', maxLength, label, { allowEmpty: false }));
}

function normalizeAnimation(input = {}) {
    const source = isPlainObject(input) ? input : {};
    const type = String(source.type || 'none');
    if (!ANIMATION_TYPES.includes(type)) throw presentationError('不支持的元素动画类型。', 400, 'PRESENTATION_ANIMATION_INVALID');
    return { type, durationMs: type === 'none' ? 0 : normalizeNumber(source.durationMs ?? source.duration_ms, 500, 100, 10000, '动画时长'), delayMs: type === 'none' ? 0 : normalizeNumber(source.delayMs ?? source.delay_ms, 0, 0, 10000, '动画延迟'), direction: normalizeBoundedText(source.direction, '', 24, '动画方向', { allowEmpty: true }) };
}

function normalizeBounds(input = {}, canvas = ASPECT_RATIOS['16:9']) {
    const x = normalizeNumber(input.x, 0, 0, canvas.width, '元素横坐标');
    const y = normalizeNumber(input.y, 0, 0, canvas.height, '元素纵坐标');
    const width = normalizeNumber(input.width, 100, 1, canvas.width, '元素宽度');
    const height = normalizeNumber(input.height, 60, 1, canvas.height, '元素高度');
    if (x + width > canvas.width + 0.01 || y + height > canvas.height + 0.01) {
        throw presentationError('元素不能超出页面边界。', 400, 'PRESENTATION_BOUNDS_INVALID');
    }
    return { x, y, width, height, rotation: normalizeNumber(input.rotation, 0, -360, 360, '元素旋转角度') };
}

function normalizeTextStyle(input = {}) {
    if (!isPlainObject(input)) throw presentationError('文本样式必须是对象。');
    const fontFamily = normalizeBoundedText(input.fontFamily, 'Microsoft YaHei', 120, '字体名称');
    const result = {
        fontFamily,
        fontSize: normalizeNumber(input.fontSize, 18, 6, 96, '字号'),
        fontWeight: normalizeNumber(input.fontWeight, 400, 100, 900, '字重'),
        color: normalizeColor(input.color, '#1F2937'),
        align: ALIGNMENTS.includes(String(input.align || 'left')) ? String(input.align || 'left') : 'left',
        verticalAlign: V_ALIGNMENTS.includes(String(input.verticalAlign || 'top')) ? String(input.verticalAlign || 'top') : 'top',
        lineHeight: normalizeNumber(input.lineHeight, 1.35, 0.8, 3, '行高'),
        italic: normalizeBoolean(input.italic),
        underline: normalizeBoolean(input.underline),
        bullet: normalizeBoolean(input.bullet),
        padding: normalizeNumber(input.padding, 0, 0, 80, '文本内边距')
    };
    return result;
}

function normalizeElement(input, canvas, index) {
    if (!isPlainObject(input)) throw presentationError(`第 ${index + 1} 个元素必须是对象。`);
    const type = String(input.type || '').trim();
    if (!ELEMENT_TYPES.includes(type)) throw presentationError(`不支持的元素类型：${type || '空'}。`, 400, 'PRESENTATION_ELEMENT_TYPE_INVALID');
    const base = {
        id: normalizeId(input.id || `element_${index + 1}`, '元素标识'),
        type,
        ...normalizeBounds(input, canvas),
        zIndex: normalizeNumber(input.zIndex, index + 1, -1000, 1000, '元素层级'),
        groupId: input.groupId || input.group_id ? normalizeId(input.groupId || input.group_id, '元素组合标识') : '',
        locked: normalizeBoolean(input.locked),
        visible: normalizeBoolean(input.visible, true),
        sourceRefs: normalizeStringArray(input.sourceRefs, 50, 160, '元素来源引用'),
        animation: normalizeAnimation(input.animation)
    };
    if (type === 'text') {
        return {
            ...base,
            content: { text: normalizeBoundedText(input.content?.text ?? input.text, '', MAX_TEXT_LENGTH, '文本内容', { allowEmpty: true, trim: false }) },
            style: normalizeTextStyle(input.style || {})
        };
    }
    if (type === 'image') {
        const assetRef = String(input.assetRef ?? input.asset_ref ?? '').trim();
        if (!CAS_REF_PATTERN.test(assetRef)) {
            throw presentationError('图片必须引用当前租户受控的素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID');
        }
        return {
            ...base,
            assetRef,
            fit: ['cover', 'contain', 'stretch'].includes(String(input.fit || 'cover')) ? String(input.fit || 'cover') : 'cover',
            opacity: normalizeNumber(input.opacity, 1, 0, 1, '图片透明度'),
            intrinsicWidth: normalizeNumber(input.intrinsicWidth ?? input.intrinsic_width, 0, 0, 100000, '图片像素宽度'),
            intrinsicHeight: normalizeNumber(input.intrinsicHeight ?? input.intrinsic_height, 0, 0, 100000, '图片像素高度'),
            alt: normalizeBoundedText(input.alt, '', 300, '图片替代文本', { allowEmpty: true })
        };
    }
    if (type === 'media') {
        const assetRef = String(input.assetRef ?? input.asset_ref ?? '').trim();
        if (!CAS_REF_PATTERN.test(assetRef)) throw presentationError('音视频必须引用当前租户受控的素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID');
        const posterAssetRef = String(input.posterAssetRef ?? input.poster_asset_ref ?? '').trim();
        if (posterAssetRef && !CAS_REF_PATTERN.test(posterAssetRef)) throw presentationError('媒体海报必须引用当前租户受控的素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID');
        const mediaType = String(input.mediaType || input.media_type || 'video');
        if (!MEDIA_TYPES.includes(mediaType)) throw presentationError('仅支持音频或视频媒体。', 400, 'PRESENTATION_MEDIA_TYPE_INVALID');
        return { ...base, mediaType, assetRef, posterAssetRef, autoPlay: normalizeBoolean(input.autoPlay ?? input.auto_play), loop: normalizeBoolean(input.loop), showControls: normalizeBoolean(input.showControls ?? input.show_controls, true), alt: normalizeBoundedText(input.alt, '', 300, '媒体替代文本', { allowEmpty: true }) };
    }
    if (type === 'attachment') {
        const assetRef = String(input.assetRef ?? input.asset_ref ?? '').trim();
        if (!CAS_REF_PATTERN.test(assetRef)) throw presentationError('附件必须引用当前租户受控的素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID');
        return { ...base, assetRef, filename: normalizeBoundedText(input.filename, '附件', 240, '附件名称'), description: normalizeBoundedText(input.description, '', 500, '附件说明', { allowEmpty: true }) };
    }
    if (type === 'diagram') {
        const diagramType = String(input.diagramType || input.diagram_type || 'process');
        if (!DIAGRAM_TYPES.includes(diagramType)) throw presentationError('不支持的图示类型。', 400, 'PRESENTATION_DIAGRAM_TYPE_INVALID');
        const items = normalizeStringArray(input.items, 12, 240, '图示节点');
        if (items.length < 2) throw presentationError('图示至少需要两个节点。', 400, 'PRESENTATION_DIAGRAM_INVALID');
        return { ...base, diagramType, items, style: { fill: normalizeColor(input.style?.fill, '#EFF6FF'), stroke: normalizeColor(input.style?.stroke, '#2563EB'), textColor: normalizeColor(input.style?.textColor, '#1E3A8A'), fontSize: normalizeNumber(input.style?.fontSize, 16, 6, 48, '图示字号') } };
    }
    if (type === 'shape') {
        const shapeType = String(input.shapeType || 'rect');
        if (!SHAPE_TYPES.includes(shapeType)) throw presentationError('不支持的形状类型。', 400, 'PRESENTATION_SHAPE_INVALID');
        return {
            ...base,
            shapeType,
            style: {
                fill: normalizeColor(input.style?.fill, '#FFFFFF'),
                stroke: normalizeColor(input.style?.stroke, '#CBD5E1'),
                strokeWidth: normalizeNumber(input.style?.strokeWidth, 1, 0, 20, '线条宽度'),
                opacity: normalizeNumber(input.style?.opacity, 1, 0, 1, '形状透明度'),
                radius: normalizeNumber(input.style?.radius, 12, 0, 100, '圆角半径')
            }
        };
    }
    if (type === 'table') {
        const columns = normalizeStringArray(input.columns, MAX_TABLE_COLUMNS, 200, '表格列');
        if (!columns.length) throw presentationError('表格至少需要一列。', 400, 'PRESENTATION_TABLE_INVALID');
        if (!Array.isArray(input.rows) || input.rows.length > MAX_TABLE_ROWS) throw presentationError('表格行数据无效或超过上限。', 400, 'PRESENTATION_TABLE_INVALID');
        const rows = input.rows.map((row, rowIndex) => {
            if (!Array.isArray(row) || row.length !== columns.length) throw presentationError(`表格第 ${rowIndex + 1} 行列数不匹配。`, 400, 'PRESENTATION_TABLE_INVALID');
            return row.map(cell => normalizeBoundedText(cell, '', 2000, '表格单元格', { allowEmpty: true, trim: false }));
        });
        return {
            ...base,
            columns,
            rows,
            style: {
                headerFill: normalizeColor(input.style?.headerFill, '#1769AA'),
                headerColor: normalizeColor(input.style?.headerColor, '#FFFFFF'),
                cellFill: normalizeColor(input.style?.cellFill, '#FFFFFF'),
                cellColor: normalizeColor(input.style?.cellColor, '#1F2937'),
                borderColor: normalizeColor(input.style?.borderColor, '#CBD5E1'),
                fontSize: normalizeNumber(input.style?.fontSize, 14, 6, 48, '表格字号')
            }
        };
    }
    const chartType = String(input.chartType || 'bar');
    if (!CHART_TYPES.includes(chartType)) throw presentationError('不支持的图表类型。', 400, 'PRESENTATION_CHART_INVALID');
    const columns = normalizeStringArray(input.data?.columns, 12, 100, '图表字段');
    if (columns.length < 2) throw presentationError('图表至少需要分类字段和数值字段。', 400, 'PRESENTATION_CHART_INVALID');
    if (!Array.isArray(input.data?.rows) || input.data.rows.length > MAX_CHART_ROWS) throw presentationError('图表数据无效或超过上限。', 400, 'PRESENTATION_CHART_INVALID');
    const rows = input.data.rows.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== columns.length) throw presentationError(`图表第 ${rowIndex + 1} 行字段数不匹配。`, 400, 'PRESENTATION_CHART_INVALID');
        return row.map((value, cellIndex) => {
            if (cellIndex === 0) return normalizeBoundedText(value, '', 160, '图表分类', { allowEmpty: true });
            const number = Number(value);
            if (!Number.isFinite(number)) throw presentationError('图表数值必须是数字。', 400, 'PRESENTATION_CHART_INVALID');
            return Math.round(number * 1000000) / 1000000;
        });
    });
    return {
        ...base,
        chartType,
        title: normalizeBoundedText(input.title, '', 240, '图表标题', { allowEmpty: true }),
        data: { columns, rows },
        options: {
            showLegend: normalizeBoolean(input.options?.showLegend, columns.length > 2),
            showLabels: normalizeBoolean(input.options?.showLabels, false),
            colors: normalizeStringArray(input.options?.colors, 12, 7, '图表颜色').map(color => normalizeColor(color))
        },
        binding: input.binding && isPlainObject(input.binding) ? {
            datasetId: normalizeBoundedText(input.binding.datasetId, '', 120, '数据集标识', { allowEmpty: true }),
            queryDigest: normalizeBoundedText(input.binding.queryDigest, '', 128, '查询摘要', { allowEmpty: true })
        } : undefined
    };
}

function normalizeSlide(input, canvas, index) {
    if (!isPlainObject(input)) throw presentationError(`第 ${index + 1} 页必须是对象。`);
    if (!Array.isArray(input.elements)) throw presentationError(`第 ${index + 1} 页元素必须是数组。`);
    if (input.elements.length > MAX_ELEMENTS_PER_SLIDE) throw presentationError(`第 ${index + 1} 页元素数量超过上限。`, 413, 'PRESENTATION_ELEMENTS_TOO_LARGE');
    const ids = new Set();
    const elements = input.elements.map((element, elementIndex) => {
        const normalized = normalizeElement(element, canvas, elementIndex);
        if (ids.has(normalized.id)) throw presentationError(`第 ${index + 1} 页存在重复元素标识。`, 400, 'PRESENTATION_ELEMENT_ID_DUPLICATE');
        ids.add(normalized.id);
        return normalized;
    }).sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
    const transitionInput = input.transition && isPlainObject(input.transition) ? input.transition : {};
    const transitionType = String(transitionInput.type || 'none');
    if (!TRANSITION_TYPES.includes(transitionType)) throw presentationError('不支持的页面转场类型。', 400, 'PRESENTATION_TRANSITION_INVALID');
    const transition = { type: transitionType, durationMs: transitionType === 'none' ? 0 : normalizeNumber(transitionInput.durationMs ?? transitionInput.duration_ms, 500, 100, 10000, '转场时长'), direction: normalizeBoundedText(transitionInput.direction, '', 24, '转场方向', { allowEmpty: true }) };
    return {
        id: normalizeId(input.id || `slide_${index + 1}`, '页面标识'),
        index,
        type: normalizeBoundedText(input.type, 'content', 48, '页面类型'),
        layoutId: normalizeBoundedText(input.layoutId, 'title-content', 96, '布局标识'),
        sectionId: normalizeBoundedText(input.sectionId, '', 96, '章节标识', { allowEmpty: true }),
        background: {
            fill: normalizeColor(input.background?.fill, '#FFFFFF'),
            imageAssetRef: input.background?.imageAssetRef ? (() => {
                const ref = String(input.background.imageAssetRef).trim();
                if (!CAS_REF_PATTERN.test(ref)) throw presentationError('背景图片必须引用受控素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID');
                return ref;
            })() : '',
            opacity: normalizeNumber(input.background?.opacity, 1, 0, 1, '背景透明度')
        },
        elements,
        speakerNotes: normalizeBoundedText(input.speakerNotes, '', 12000, '演讲者备注', { allowEmpty: true, trim: false }),
        sourceRefs: normalizeStringArray(input.sourceRefs, 100, 160, '页面来源引用'),
        transition
    };
}

function normalizeTheme(input = {}) {
    if (!isPlainObject(input)) throw presentationError('主题必须是对象。');
    return {
        name: normalizeBoundedText(input.name, '默认主题', 120, '主题名称'),
        colors: {
            primary: normalizeColor(input.colors?.primary, '#1769AA'),
            secondary: normalizeColor(input.colors?.secondary, '#5B8FF9'),
            accent: normalizeColor(input.colors?.accent, '#61DDAA'),
            text: normalizeColor(input.colors?.text, '#1F2937'),
            background: normalizeColor(input.colors?.background, '#F7F9FC')
        },
        fonts: {
            heading: normalizeBoundedText(input.fonts?.heading, 'Microsoft YaHei', 120, '标题字体'),
            body: normalizeBoundedText(input.fonts?.body, 'Microsoft YaHei', 120, '正文字体')
        },
        fontAssets: {
            heading: input.fontAssets?.heading ? (() => { const ref = String(input.fontAssets.heading).trim(); if (!CAS_REF_PATTERN.test(ref)) throw presentationError('标题字体必须引用受控字体素材。', 400, 'PRESENTATION_ASSET_REF_INVALID'); return ref; })() : '',
            body: input.fontAssets?.body ? (() => { const ref = String(input.fontAssets.body).trim(); if (!CAS_REF_PATTERN.test(ref)) throw presentationError('正文字体必须引用受控字体素材。', 400, 'PRESENTATION_ASSET_REF_INVALID'); return ref; })() : ''
        },
        chartPalette: normalizeStringArray(input.chartPalette, 12, 7, '图表色板').map(color => normalizeColor(color))
    };
}

function normalizePresentation(input, options = {}) {
    if (!isPlainObject(input)) throw presentationError('演示文稿内容必须是对象。');
    const aspectRatio = String(input.aspectRatio || options.aspectRatio || '16:9');
    const canvas = ASPECT_RATIOS[aspectRatio];
    if (!canvas) throw presentationError('页面比例只支持 16:9 或 4:3。', 400, 'PRESENTATION_RATIO_INVALID');
    if (!Array.isArray(input.slides) || !input.slides.length) throw presentationError('演示文稿至少需要一页。');
    if (input.slides.length > MAX_SLIDES) throw presentationError(`演示文稿页数不能超过 ${MAX_SLIDES} 页。`, 413, 'PRESENTATION_SLIDES_TOO_LARGE');
    const slideIds = new Set();
    const slides = input.slides.map((slide, index) => {
        const normalized = normalizeSlide(slide, canvas, index);
        if (slideIds.has(normalized.id)) throw presentationError('演示文稿存在重复页面标识。', 400, 'PRESENTATION_SLIDE_ID_DUPLICATE');
        slideIds.add(normalized.id);
        return normalized;
    });
    const result = {
        schemaVersion: PRESENTATION_IR_VERSION,
        presentationId: input.presentationId ? normalizeId(input.presentationId, '演示文稿标识') : undefined,
        title: normalizeBoundedText(input.title, '未命名演示文稿', 160, '演示文稿名称'),
        aspectRatio,
        width: canvas.width,
        height: canvas.height,
        template: {
            id: normalizeBoundedText(input.template?.id, 'business-blue', 96, '模板标识'),
            version: normalizeNumber(input.template?.version, 1, 1, 1000000, '模板版本'),
            snapshotDigest: normalizeBoundedText(input.template?.snapshotDigest, '', 160, '模板摘要', { allowEmpty: true })
        },
        theme: normalizeTheme(input.theme || {}),
        slides,
        sources: Array.isArray(input.sources) ? input.sources.slice(0, MAX_SOURCES).map((source, index) => {
            if (!isPlainObject(source)) throw presentationError(`第 ${index + 1} 个来源必须是对象。`);
            return {
                id: normalizeId(source.id || `source_${index + 1}`, '来源标识'),
                title: normalizeBoundedText(source.title, '未命名来源', 240, '来源标题'),
                type: normalizeBoundedText(source.type, 'material', 48, '来源类型'),
                locator: normalizeBoundedText(source.locator, '', 500, '来源定位', { allowEmpty: true }),
                digest: normalizeBoundedText(source.digest, '', 160, '来源摘要', { allowEmpty: true })
            };
        }) : [],
        metadata: {
            aiGenerated: normalizeBoolean(input.metadata?.aiGenerated),
            coverAssetRef: input.metadata?.coverAssetRef ? (() => { const ref = String(input.metadata.coverAssetRef).trim(); if (!CAS_REF_PATTERN.test(ref)) throw presentationError('封面图片必须引用受控素材对象。', 400, 'PRESENTATION_ASSET_REF_INVALID'); return ref; })() : '',
            language: normalizeBoundedText(input.metadata?.language, 'zh-CN', 24, '语言'),
            updatedAt: normalizeBoundedText(input.metadata?.updatedAt, '', 64, '更新时间', { allowEmpty: true })
        }
    };
    const sourceIds = new Set();
    result.sources.forEach(source => {
        if (sourceIds.has(source.id)) throw presentationError('演示文稿存在重复来源标识。', 400, 'PRESENTATION_SOURCE_ID_DUPLICATE');
        sourceIds.add(source.id);
    });
    result.slides.forEach(slide => {
        [...slide.sourceRefs, ...slide.elements.flatMap(element => element.sourceRefs || [])].forEach(ref => {
            if (ref && !sourceIds.has(ref)) throw presentationError(`页面引用了不存在的来源：${ref}。`, 400, 'PRESENTATION_SOURCE_REF_INVALID');
        });
    });
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw presentationError('演示文稿内容超过大小上限，请减少页面、文字或内嵌数据。', 413, 'PRESENTATION_DOCUMENT_TOO_LARGE');
    }
    return result;
}

function defaultPresentation({ presentationId = '', title = '未命名演示文稿', template, aspectRatio = '16:9' } = {}) {
    const ratio = ASPECT_RATIOS[aspectRatio] ? aspectRatio : '16:9';
    const canvas = ASPECT_RATIOS[ratio];
    const theme = template?.theme || template?.definition?.theme || {};
    return normalizePresentation({
        presentationId: presentationId || undefined,
        title,
        aspectRatio: ratio,
        template: { id: template?.id || 'business-blue', version: template?.version || 1, snapshotDigest: template?.snapshotDigest || '' },
        theme,
        slides: [{
            id: 'slide_1',
            type: 'cover',
            layoutId: 'cover',
            background: { fill: theme?.colors?.background || '#F7F9FC' },
            elements: [
                {
                    id: 'title', type: 'text', x: 88, y: Math.round(canvas.height * 0.28), width: canvas.width - 176, height: 96,
                    content: { text: title },
                    style: { fontFamily: theme?.fonts?.heading || 'Microsoft YaHei', fontSize: 40, fontWeight: 700, color: theme?.colors?.text || '#1F2937', align: 'center', verticalAlign: 'middle' }
                },
                {
                    id: 'subtitle', type: 'text', x: 160, y: Math.round(canvas.height * 0.48), width: canvas.width - 320, height: 48,
                    content: { text: '点击编辑副标题' },
                    style: { fontFamily: theme?.fonts?.body || 'Microsoft YaHei', fontSize: 20, color: theme?.colors?.primary || '#1769AA', align: 'center', verticalAlign: 'middle' }
                }
            ]
        }]
    });
}

function validatePresentation(input, options = {}) {
    try {
        return { valid: true, errors: [], presentation: normalizePresentation(input, options) };
    } catch (error) {
        return { valid: false, errors: [error.message], presentation: null, code: error.code || 'PRESENTATION_INVALID' };
    }
}

function computePresentationDigest(presentation) {
    const canonical = normalizePresentation(presentation);
    return crypto.createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

function collectPresentationAssetRefs(presentation) {
    const checked = normalizePresentation(presentation);
    const refs = new Set();
    checked.slides.forEach(slide => {
        if (slide.background.imageAssetRef) refs.add(slide.background.imageAssetRef);
        if (checked.theme.fontAssets?.heading) refs.add(checked.theme.fontAssets.heading);
        if (checked.theme.fontAssets?.body) refs.add(checked.theme.fontAssets.body);
        if (checked.metadata?.coverAssetRef) refs.add(checked.metadata.coverAssetRef);
        slide.elements.forEach(element => {
            if (['image', 'media', 'attachment'].includes(element.type) && element.assetRef) refs.add(element.assetRef);
            if (element.type === 'media' && element.posterAssetRef) refs.add(element.posterAssetRef);
        });
    });
    return [...refs].sort();
}

module.exports = {
    CAS_REF_PATTERN,
    MAX_SLIDES,
    collectPresentationAssetRefs,
    computePresentationDigest,
    defaultPresentation,
    normalizePresentation,
    presentationError,
    validatePresentation
};
