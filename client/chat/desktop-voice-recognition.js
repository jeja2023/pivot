/* 桌面本地识别适配浏览器事件接口，录音和识别均留在操作系统。 */
(function () {
    function supported() {
        const bridge = window.pivotDesktop;
        return Boolean(bridge?.getVoiceRecognitionStatus && bridge.startVoiceRecognition && bridge.stopVoiceRecognition && bridge.onVoiceRecognitionEvent);
    }
    function createRecognition(language) {
        const bridge = window.pivotDesktop;
        let running = false;
        let id = '';
        let unsubscribe = null;
        let results = [];
        const recognition = {
            lang: language, processLocally: true, usesDesktopInput: true, continuous: false,
            start() {
                if (running) throw Object.assign(new Error('识别已开始。'), { name: 'InvalidStateError' });
                running = true;
                results = [];
                const requestId = `speech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                id = requestId;
                unsubscribe?.();
                unsubscribe = bridge.onVoiceRecognitionEvent(event => {
                    if (!running || id !== requestId || event.id !== requestId) return;
                    if (event.type === 'started') recognition.onstart?.();
                    if (event.type === 'result') {
                        results.push({ isFinal: true, 0: { transcript: event.text || '' } });
                        recognition.onresult?.({ resultIndex: results.length - 1, results: results.slice() });
                        if (!recognition.continuous) recognition.abort();
                    }
                    if (event.type === 'error') { recognition.onerror?.(event); recognition.abort(); }
                    if (event.type === 'ended') recognition.abort();
                });
                Promise.resolve(bridge.startVoiceRecognition({ id: requestId, language: recognition.lang })).then(result => {
                    if (!running || id !== requestId) return;
                    if (result?.success === false) {
                        recognition.onerror?.({ error: result.code, voiceMessage: result.error || 'Windows 本地识别启动失败。' });
                        recognition.abort();
                    }
                }).catch(() => {
                    if (!running || id !== requestId) return;
                    recognition.onerror?.({ error: 'native-recognition-unavailable', voiceMessage: '桌面语音连接已断开，请重启客户端后重试。' });
                    recognition.abort();
                });
            },
            abort() {
                if (!running) return;
                running = false;
                const stoppedId = id;
                id = '';
                unsubscribe?.();
                unsubscribe = null;
                void bridge.stopVoiceRecognition(stoppedId).catch(() => {});
                recognition.onend?.();
            },
            stop() { recognition.abort(); }
        };
        return recognition;
    }
    async function prepare(language) {
        if (!supported()) return null;
        const status = await window.pivotDesktop.getVoiceRecognitionStatus();
        if (status.supported === false) return null;
        if (!status.languages?.some(item => item.toLowerCase() === language.toLowerCase())) {
            throw Object.assign(new Error(), { voiceMessage: status.reason || `Windows 尚未安装 ${language} 的本地语音识别组件，请在系统语言设置中安装语音功能。` });
        }
        return createRecognition(language);
    }
    window.Pivot?.exposeModule?.('chat.desktopVoiceRecognition', { supported, prepare });
}());
