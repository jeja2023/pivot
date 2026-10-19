"""部署内离线语音识别，只读取 stdin 音频，不下载模型或写录音文件。"""
import base64
import io
import json
import os
import re
import sys
import wave
from pathlib import Path


def main():
    from vosk import KaldiRecognizer, Model, SetLogLevel
    SetLogLevel(-1)
    model_path = Path(os.environ.get("PIVOT_SERVER_VOICE_MODEL_PATH", "/opt/pivot-speech/model"))
    if not (model_path / "am" / "final.mdl").is_file() or not (model_path / "conf" / "model.conf").is_file():
        raise ValueError("model-unavailable")
    if os.environ.get("PIVOT_SERVER_SPEECH_MODE") == "probe":
        print(json.dumps({"languages": ["zh-CN"], "provider": "server_vosk"}))
        return
    raw = sys.stdin.buffer.readline(860000)
    payload = json.loads(raw)
    if payload.get("language") != "zh-CN":
        raise ValueError("language-unavailable")
    audio = bytearray(base64.b64decode(payload["audioBase64"], validate=True))
    payload = None
    raw = None
    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000 or source.getnframes() > 320000:
                raise ValueError("invalid-wave")
            recognizer = KaldiRecognizer(Model(str(model_path)), 16000)
            parts = []
            while True:
                chunk = source.readframes(4000)
                if not chunk:
                    break
                if recognizer.AcceptWaveform(chunk):
                    parts.append(json.loads(recognizer.Result()).get("text", ""))
            parts.append(json.loads(recognizer.FinalResult()).get("text", ""))
            text = " ".join(part for part in parts if part).strip()
            text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
            print(json.dumps({"text": text, "language": "zh-CN"}, ensure_ascii=False))
    finally:
        audio[:] = b"\x00" * len(audio)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "local-recognition-failed"}))
        sys.exit(1)
