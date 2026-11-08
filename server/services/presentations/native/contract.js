'use strict';

const { error } = require('../master/runtime');
function id(value) { if (!/^native_[a-f0-9]{32}$/.test(String(value || ''))) throw error('原稿文稿标识无效。'); return String(value); }
function version(value) { if (!Number.isSafeInteger(value) || value < 1) throw error('请提供有效的原稿版本号。'); return value; }
function normalize(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('原稿任务参数必须是字段对象。');
    const kind = input.kind === undefined ? 'import' : input.kind;
    if (!['import', 'patch', 'video', 'restore'].includes(kind)) throw error('原稿任务类型无效。');
    if (input.title !== undefined && (typeof input.title !== 'string' || /[\u0000-\u001f\u007f]/.test(input.title) || input.title.length > 160)) throw error('原稿名称须为不超过160字的正常文字。');
    const title = String(input.title || '原稿演示文稿').trim();
    const request = { kind, title };
    if (kind === 'import') {
        const sources = ['sourceAssetId', 'sourceRenditionId', 'presentationId'].filter(key => input[key] !== undefined && input[key] !== '');
        if (sources.length !== 1) throw error('请选择一个已上传PPTX、制作结果或当前文稿作为原稿。');
        for (const key of sources) {
            if (key !== 'presentationId' && !/^[1-9]\d{0,14}$/.test(String(input[key]))) throw error('原稿来源标识无效。');
            if (key === 'presentationId' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(input[key]))) throw error('当前文稿标识无效。');
            request[key] = String(input[key]);
        }
    } else { request.documentId = id(input.documentId); request.baseVersion = version(input.baseVersion); }
    if (kind === 'patch') {
        if (!Array.isArray(input.patches) || !input.patches.length || input.patches.length > 200 || Buffer.byteLength(JSON.stringify(input.patches)) > 512 * 1024) throw error('请提交1至200个对象修改，单次总量不超过512KiB。');
        for (const patch of input.patches) if (!patch || !Number.isInteger(patch.slideIndex) || patch.slideIndex < 0 || patch.slideIndex >= 40 || !/^\d{1,10}$/.test(String(patch.objectId))) throw error('原稿对象或页码标识无效。');
        request.patches = input.patches;
    }
    if (kind === 'restore') request.sourceVersion = version(input.sourceVersion);
    if (kind === 'video') {
        if (input.mode !== 'page_video' || input.acknowledgeStatic !== true) throw error('请确认导出页面视频：保留静态页面与所选旁白，不播放原生对象动画和嵌入视频。');
        const duration = Number(input.duration ?? 5), fps = Number(input.fps ?? 24), resolution = input.resolution || '720p', transition = input.transition || 'fade';
        if (!Number.isFinite(duration) || duration < 0.5 || duration > 60 || ![24, 30].includes(fps) || !['720p', '1080p'].includes(resolution) || !['none', 'fade'].includes(transition)) throw error('视频时长、帧率、清晰度或转场无效。');
        if (input.narration !== undefined && (!Array.isArray(input.narration) || input.narration.length > 40)) throw error('最多为40页配置旁白。');
        const seen = new Set();
        for (const audio of input.narration || []) {
            if (!Number.isInteger(audio.slideIndex) || audio.slideIndex < 0 || audio.slideIndex >= 40 || !/^[1-9]\d{0,14}$/.test(String(audio.assetId)) || seen.has(audio.slideIndex)) throw error('旁白页码或素材标识无效，不能重复指定同一页。');
            seen.add(audio.slideIndex);
        }
        request.video = { duration, fps, resolution, transition, narration: input.narration || [] };
    }
    return request;
}
module.exports = { id, version, normalize };
