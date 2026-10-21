'use strict';

const MESSAGES = {
    VOICE_EMBEDDED_PYTHON_MISSING: '找不到语音 Python 解释器。请先准备项目语音运行环境。',
    VOICE_EMBEDDED_DEPENDENCY_MISSING: '语音 Python 环境缺少运行依赖。请准备 FunASR、Silero VAD 和 CPU 推理依赖后重试。',
    VOICE_EMBEDDED_MODEL_MISSING: '语音模型文件不完整。请检查 data/speech-models 下三个模型的权重、配置和词表。',
    VOICE_EMBEDDED_STARTUP_TIMEOUT: '语音模型加载超时。请检查可用内存、磁盘读取速度和启动等待时间。',
    VOICE_EMBEDDED_LOAD_FAILED: '语音模型加载失败。请检查运行依赖与模型版本是否匹配。',
    VOICE_EMBEDDED_UNAVAILABLE: '内置中文语音尚未就绪，请检查模型目录与 Python 语音依赖。'
};
const PACKAGES = new Set(['funasr', 'silero_vad', 'torch', 'torchaudio', 'numpy', 'fastapi', 'uvicorn', 'transformers', 'websockets', 'soundfile', 'librosa', 'modelscope']);

function speechStartupDiagnostic(value = {}) {
    const code = Object.hasOwn(MESSAGES, value.code) ? value.code : 'VOICE_EMBEDDED_LOAD_FAILED';
    const missing = Array.isArray(value.missing) ? value.missing.filter(name => PACKAGES.has(name)).slice(0, 12) : [];
    return { code, reason: missing.length ? `语音 Python 环境缺少：${missing.join('、')}。请准备项目语音运行环境后重试。` : MESSAGES[code],
        ...(missing.length ? { missingDependencies: missing } : {}) };
}

module.exports = { speechStartupDiagnostic };
