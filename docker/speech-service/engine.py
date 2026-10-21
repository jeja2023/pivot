"""只加载预先导入的本地模型；识别正文与音频不写日志。"""
import os
from pathlib import Path
import threading

import numpy as np


def local_directory(name):
    root = Path(os.environ.get(name, "")).resolve()
    if not os.environ.get(name) or not root.is_dir():
        raise RuntimeError(f"缺少本地模型目录：{name}")
    return str(root)


class SpeechEngine:
    def __init__(self):
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["MODELSCOPE_OFFLINE"] = "1"
        import torch
        from silero_vad import load_silero_vad, get_speech_timestamps
        cpu_threads = max(1, min(int(os.environ.get("SPEECH_CPU_THREADS", "4")), 16))
        torch.set_num_threads(cpu_threads)
        self.torch = torch
        self.vad = load_silero_vad()
        self.timestamps = get_speech_timestamps
        self.lock = threading.Lock()
        self.backend = os.environ.get("SPEECH_BACKEND", "funasr")
        device = os.environ.get("SPEECH_DEVICE", "cpu")
        if device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("指定的 GPU 不可用，拒绝静默改变运行设备")
        if self.backend == "funasr":
            from funasr import AutoModel
            self.model = AutoModel(model=local_directory("SPEECH_MODEL_DIR"), device=device,
                                   ncpu=cpu_threads, disable_update=True, disable_pbar=True, trust_remote_code=False)
            self.online = AutoModel(model=local_directory("SPEECH_STREAM_MODEL_DIR"), device=device,
                                    ncpu=cpu_threads, disable_update=True, disable_pbar=True, trust_remote_code=False) if os.environ.get("SPEECH_STREAM_MODEL_DIR") else None
            self.punctuation = AutoModel(model=local_directory("SPEECH_PUNC_MODEL_DIR"), device="cpu",
                                         ncpu=cpu_threads, disable_update=True, disable_pbar=True, trust_remote_code=False) if os.environ.get("SPEECH_PUNC_MODEL_DIR") else None
        elif self.backend == "qwen":
            from qwen_asr import Qwen3ASRModel
            # 2080 Ti 使用 FP16，不要求 BF16、FlashAttention 或 vLLM。
            self.model = Qwen3ASRModel.from_pretrained(local_directory("SPEECH_MODEL_DIR"),
                dtype=torch.float16 if device.startswith("cuda") else torch.float32, device_map=device,
                attn_implementation="sdpa", max_new_tokens=1024, max_inference_batch_size=1)
            self.online = None
        else:
            raise RuntimeError("未知语音模型后端")

    @property
    def streaming(self):
        return self.online is not None

    def transcribe(self, samples, hotwords):
        spans = self.timestamps(self.torch.from_numpy(samples.copy()), self.vad, sampling_rate=16000,
                                min_speech_duration_ms=160, min_silence_duration_ms=200, speech_pad_ms=160)
        if not spans:
            return {"text": "", "noSpeech": True, "confidence": None, "requiresReview": False}
        # 保留句内停顿，仅裁掉首尾无语音区间，避免拼接破坏中文连读。
        speech = samples[max(0, spans[0]["start"] - 1600):min(len(samples), spans[-1]["end"] + 1600)]
        try:
            if self.backend == "funasr":
                result = self.model.generate(input=speech, hotword=" ".join(hotwords), batch_size_s=20)
                text = result[0].get("text", "") if result else ""
                if self.punctuation and text:
                    punctuated = self.punctuation.generate(input=text)
                    text = punctuated[0].get("text", text) if punctuated else text
            else:
                result = self.model.transcribe(audio=(speech, 16000), language="Chinese", context="、".join(hotwords))
                text = result[0].text if result else ""
            clipped = float(np.mean(np.abs(samples) >= 0.985)) > 0.02
            return {"text": str(text).strip(), "noSpeech": False, "confidence": None,
                    "requiresReview": clipped, "warnings": ["clipping"] if clipped else []}
        finally:
            speech = None

    def partial(self, samples, cache, final=False):
        result = self.online.generate(input=samples, cache=cache, is_final=final,
                                     chunk_size=[0, 10, 5], encoder_chunk_look_back=4,
                                     decoder_chunk_look_back=1)
        return "".join(str(item.get("text", "")) for item in result or [])
