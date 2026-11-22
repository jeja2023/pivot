'use strict';

const { getSupplement } = require('./user-supplements');

function imageOrigin(state, path) {
    const index = (state.request.inputFiles || []).findIndex(file => file.path === path && file.imageRole !== 'decorative');
    const digest = state.request.inputDigests?.[index];
    return index >= 0 && /^inputs\/[\w.-]+\.(?:png|jpe?g|webp)$/iu.test(path)
        && state.seenImages?.includes(path) && /^[a-f0-9]{64}$/u.test(digest || '') ? { path, digest } : null;
}

function imageTranscription(state, origin) {
    const verified = state.imageTranscriptions?.[origin.path];
    if (verified?.digest !== origin.digest) return null;
    const source = getSupplement(state, verified.source);
    return source ? { path: source.path, origin } : null;
}

function supplementImageOrigin(state, path) {
    const match = Object.entries(state.imageTranscriptions || {}).find(([, proof]) => proof.source === path);
    const origin = match && imageOrigin(state, match[0]);
    return origin && origin.digest === match[1].digest ? origin : null;
}

function imageReviewTurn(state, candidate, issues) {
    if (!state.request.draftFirst || state.review?.approvals?.design) return null;
    const issue = issues.find(item => item.imagePath && !state.reviewedImageDigests?.includes(item.imageDigest));
    if (!issue) return null;
    const origin = imageOrigin(state, issue.imagePath);
    if (!origin || origin.digest !== issue.imageDigest) return null;
    const values = [...new Set(issues.filter(item => item.imagePath === origin.path).map(item => item.text))];
    const file = state.request.inputFiles.find(entry => entry.path === origin.path);
    const name = typeof file?.title === 'string' ? file.title.slice(0, 160) : '';
    const question = `请打开原始图片 ${name && name !== origin.path ? name + '（' + origin.path + '）' : origin.path} 核对数据。`;
    const context = '请在答复中输入图片上的指标、数值及单位原文。输入「跳过」可用待核对占位继续制作。待核对内容：' + values.slice(0, 20).join('；');
    return { requestInput: { kind: 'clarification', question, context }, imageReview: { origin, candidate } };
}

module.exports = { imageOrigin, imageTranscription, supplementImageOrigin, imageReviewTurn };
