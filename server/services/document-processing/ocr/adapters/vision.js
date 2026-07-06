async function recognizePage() {
    const error = new Error('视觉大模型 OCR 辅助尚未配置为批量识别引擎，请先使用 PaddleOCR 或 Tesseract。');
    error.code = 'VISION_OCR_NOT_CONFIGURED';
    throw error;
}

async function checkAvailability() {
    return {
        available: false,
        command: 'vision-model',
        error: '视觉大模型 OCR 辅助仅用于复杂版面复核，当前未配置为默认批量引擎。'
    };
}

module.exports = {
    checkAvailability,
    recognizePage
};
