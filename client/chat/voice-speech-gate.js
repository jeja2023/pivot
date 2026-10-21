/* 前端只做有界的能量起录与瞬态抑制，最终语音判定由识别服务的模型完成。 */
(function () {
    function create(sampleRate) {
        let floor = 0.0008;
        let onset = 0;
        let hangover = 0;
        return {
            analyze(samples) {
                let square = 0;
                for (const sample of samples) square += sample * sample;
                const rms = Math.sqrt(square / Math.max(samples.length, 1));
                const duration = samples.length / sampleRate;
                const threshold = Math.max(0.0018, Math.min(0.025, floor * 2.8));
                const candidate = rms >= threshold;
                if (candidate) onset += duration;
                else { onset = Math.max(0, onset - duration * 2); if (!hangover) floor = floor * 0.96 + rms * 0.04; }
                // 单次敲击或碰麦不直接开启一句话；进入语音后保留短音节和弱句尾。
                if (onset >= 0.16) hangover = 0.2;
                else hangover = Math.max(0, hangover - duration);
                return { speech: candidate && (onset >= 0.16 || hangover > 0), rms };
            }
        };
    }
    window.Pivot?.exposeModule?.('chat.voiceSpeechGate', { create });
}());
