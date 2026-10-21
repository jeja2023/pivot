"""在已导入语音环境运行的离线探针；不下载模型、不保存录音。"""
import json
import os
import time


def main():
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps
    torch.set_num_threads(2)
    started = time.monotonic()
    model = load_silero_vad()
    generator = torch.Generator().manual_seed(7)
    probes = {"silence": torch.zeros(32000), "white_noise": torch.randn(32000, generator=generator) * 0.01}
    outcomes = {}
    for name, samples in probes.items():
        spans = get_speech_timestamps(samples, model, sampling_rate=16000, min_speech_duration_ms=160)
        outcomes[name] = len(spans)
        samples.zero_()
        if spans:
            raise RuntimeError("基础非语音探针未通过，不得视为已完成声学验收")
    print(json.dumps({"torch": torch.__version__, "cudaAvailable": torch.cuda.is_available(),
                      "vadNonSpeechDetections": outcomes, "elapsedMs": round((time.monotonic() - started) * 1000),
                      "scope": "仅静音和白噪声基础探针，不代表中文准确率或现场抗噪声验收"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
