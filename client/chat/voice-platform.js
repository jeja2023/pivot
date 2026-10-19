/* 按运行环境选择桌面本地、部署内服务器或浏览器本地识别。 */
(function () {
    function failure(message) { return Object.assign(new Error(message), { voiceMessage: message }); }
    function recognitionClass() { return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition; }
    function desktopRecognition() { return window.Pivot?.moduleApi?.('chat.desktopVoiceRecognition'); }
    function serverRecognition() { return window.Pivot?.moduleApi?.('chat.serverVoiceRecognition'); }
    function browserAvailability() {
        if (globalThis.isSecureContext === false) return '语音需要 HTTPS 或受信任的本地地址，当前页面无法访问麦克风。';
        if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器无法访问麦克风，请使用支持音频输入的浏览器。';
        const Recognition = recognitionClass();
        if (!Recognition) return window.pivotDesktop
            ? '当前客户端尚未提供可用的本地识别通道，请更新客户端；仅刷新服务端页面无法补齐桌面语音能力。'
            : '当前浏览器没有语音识别能力，语音输入和实时语音不可用。';
        try {
            if (!('processLocally' in new Recognition())) return '当前浏览器无法确认本地语音识别，已保持关闭；请使用支持设备端识别的浏览器。';
        } catch (_) { return '当前浏览器的语音识别无法初始化。'; }
        return '';
    }
    function availability() { return desktopRecognition()?.supported?.() || serverRecognition()?.supported?.() ? '' : browserAvailability(); }
    function language() {
        const value = String(document.documentElement?.lang || navigator.language || 'zh-CN').trim().replace(/_/g, '-');
        if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) return 'zh-CN';
        if (/^zh(?:-hans)?(?:-cn|-sg)?$/i.test(value)) return 'zh-CN';
        if (/^zh(?:-hant)?-(?:tw|hk|mo)$/i.test(value)) return 'zh-TW';
        try { return Intl.getCanonicalLocales(value)[0] || 'zh-CN'; } catch (_) { return 'zh-CN'; }
    }
    async function prepareRecognition() {
        const reason = availability();
        if (reason) throw failure(reason);
        let serverError;
        if (desktopRecognition()?.supported?.()) {
            try { const native = await desktopRecognition().prepare(language()); if (native) return native; }
            catch (error) { serverError = error; }
        }
        if (serverRecognition()?.supported?.()) {
            try { const server = await serverRecognition().prepare(language()); if (server) return server; }
            catch (error) { serverError = error; }
        }
        const browserReason = browserAvailability();
        if (browserReason) throw serverError || failure(browserReason);
        const Recognition = recognitionClass();
        const recognition = new Recognition();
        recognition.lang = language();
        recognition.processLocally = true;
        if (recognition.processLocally !== true) throw failure('未能启用本地语音识别，语音已保持关闭。');
        if (typeof Recognition.available === 'function') {
            let status;
            let timer;
            try { status = await Promise.race([
                Recognition.available({ langs: [recognition.lang], processLocally: true }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('本地语音包检查超时')), 5000); })
            ]); }
            catch (_) { throw failure('无法检查本地语音包，请确认浏览器允许设备端语音识别后重试。'); }
            finally { if (timer) clearTimeout(timer); }
            if (status !== 'available') throw serverError || failure(status === 'downloadable' || status === 'downloading'
                ? `本地 ${recognition.lang} 语音包尚未就绪，请在浏览器安装完成后重试。`
                : window.pivotDesktop
                    ? '当前客户端内核未提供该语言的离线识别，请更新客户端以启用系统语音通道；仅更新服务端页面不够。'
                    : `当前浏览器不支持 ${recognition.lang} 的本地语音识别，请使用支持该语言的浏览器。`);
        }
        return recognition;
    }
    function errorMessage(error) {
        if (error?.voiceMessage) return error.voiceMessage;
        const detail = [error?.error, error?.name, error?.code, error?.message].filter(Boolean).join(' ').toLowerCase();
        if (/not-allowed|notallowed|permission-denied/.test(detail)) return '请在系统或浏览器设置中允许 Pivot 访问麦克风后重试。';
        if (/not-found|notfound|devicesnotfound/.test(detail)) return '未检测到可用的麦克风，请连接或启用输入设备后重试。';
        if (/not-readable|notreadable|audio-capture/.test(detail)) return '麦克风不可用或被其他程序占用，请检查输入设备后重试。';
        if (/language-not-supported/.test(detail)) return '当前语言的本地语音包不可用，请安装或启用后重试。';
        if (/network|service-not-allowed/.test(detail)) return '本地语音识别服务不可用，已停止识别；不会自动切换远程服务。';
        if (/securityerror|secure context|https/.test(detail)) return '语音需要 HTTPS 或受信任的本地地址。';
        return '语音识别失败，请检查浏览器的本地语音能力后重试。';
    }
    function refreshButtons() {
        const reason = availability();
        for (const [id, label] of [['chat-voice-input', '语音输入'], ['chat-realtime-voice', '实时语音']]) {
            const button = document.getElementById(id);
            if (!button || button.getAttribute('aria-pressed') === 'true') continue;
            const message = reason || (id === 'chat-realtime-voice' && (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance)
                ? '当前浏览器没有语音朗读能力，实时语音不可用。' : '');
            button.setAttribute('aria-disabled', message ? 'true' : 'false');
            button.setAttribute('title', message || (id === 'chat-voice-input' ? '语音输入：部署内识别，完成后可编辑发送' : '启动实时语音：部署内识别并朗读模型回答'));
            button.setAttribute('aria-label', message ? `${label}不可用：${message}` : label);
        }
    }
    window.Pivot?.exposeModule?.('chat.voicePlatform', { availability, errorMessage, language, prepareRecognition, refreshButtons,
        usesDesktopInput: () => desktopRecognition()?.supported?.() === true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshButtons, { once: true });
    else refreshButtons();
}());
