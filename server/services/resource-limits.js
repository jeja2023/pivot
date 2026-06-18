const {
    getAttachmentRuntimeConfig,
    getKnowledgeRuntimeConfig,
    getRagRuntimeConfig,
    getUploadRuntimeConfig
} = require('./runtime-settings');

const BYTE = 1024 * 1024;

function bytesToMb(bytes) {
    return Math.max(1, Math.round(Number(bytes || 0) / BYTE));
}

function getUploadLimits() {
    return getUploadRuntimeConfig();
}

function getImageLimits() {
    const config = getUploadRuntimeConfig();
    return {
        uploadMaxBytes: config.imageUploadMaxBytes,
        contextMaxBytes: config.imageContextMaxBytes,
        maxImagesPerMessage: config.maxImagesPerMessage
    };
}

function getAttachmentContextLimit() {
    return getAttachmentRuntimeConfig().contextMaxChars;
}

function getKnowledgeLimits() {
    return getKnowledgeRuntimeConfig();
}

function getRagLimits() {
    return getRagRuntimeConfig();
}

module.exports = {
    bytesToMb,
    getAttachmentContextLimit,
    getImageLimits,
    getKnowledgeLimits,
    getRagLimits,
    getUploadLimits
};
