"""不下载模型的网关契约测试，真实模型精度由现场语料另行验收。"""
import base64
import importlib.util
import io
import os
from pathlib import Path
import struct
import sys
import threading
import unittest
import wave

from fastapi.testclient import TestClient

MODULE = Path(__file__).resolve().parents[2] / "docker" / "speech-service" / "app.py"
spec = importlib.util.spec_from_file_location("speech_gateway", MODULE)
gateway = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gateway
spec.loader.exec_module(gateway)


class Engine:
    backend = "test"
    streaming = True

    def __init__(self):
        self.lock = threading.Lock()
        self.calls = 0

    def transcribe(self, samples, words):
        self.calls += 1
        return {"text": "句末正确结果", "confidence": None, "noSpeech": False}

    def partial(self, samples, cache, final=False):
        return "暂态结果"


def audio():
    target = io.BytesIO()
    with wave.open(target, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(struct.pack("<h", 100) * 8000)
    return base64.b64encode(target.getvalue()).decode()


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.secret = "test-only-speech-secret-32-characters"
        os.environ["SPEECH_API_KEY"] = self.secret
        self.engine = Engine()
        self.client = TestClient(gateway.create_app(lambda: self.engine))
        self.client.__enter__()
        self.headers = {"Authorization": f"Bearer {self.secret}"}

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def test_authentication_and_limits(self):
        self.assertEqual(self.client.get("/health").status_code, 401)
        self.assertTrue(self.client.get("/health", headers=self.headers).json()["streaming"])
        self.assertEqual(self.client.post("/transcribe", json={"audioBase64": "invalid"}, headers=self.headers).status_code, 400)
        self.assertEqual(self.client.post("/transcribe", content=b"x" * 900001, headers=self.headers).status_code, 413)
        self.assertEqual(self.client.post("/transcribe", json={"audioBase64": audio(), "hotwords": ["字" * 41]}, headers=self.headers).status_code, 400)

    def test_http_results_and_capacity(self):
        result = self.client.post("/transcribe", json={"audioBase64": audio(), "hotwords": ["智枢"]}, headers=self.headers)
        self.assertEqual(result.json()["text"], "句末正确结果")
        self.engine.lock.acquire()
        try:
            self.assertEqual(self.client.post("/transcribe", json={"audioBase64": audio()}, headers=self.headers).status_code, 429)
        finally:
            self.engine.lock.release()

    def test_streaming_two_pass_and_reset(self):
        with self.client.websocket_connect("/stream", headers=self.headers) as socket:
            for _ in range(2):
                socket.send_json({"type": "begin", "hotwords": []})
                socket.send_bytes(b"\0\0" * 9600)
                self.assertEqual(socket.receive_json()["type"], "partial")
                socket.send_json({"type": "end"})
                result = socket.receive_json()
                self.assertEqual(result["type"], "final")
                self.assertEqual(result["text"], "句末正确结果")
        self.assertFalse(self.engine.lock.locked())

    def test_numeric_disagreement_requires_confirmation(self):
        self.engine.partial = lambda samples, cache, final=False: "第十七条" if final else ""
        self.engine.transcribe = lambda samples, words: {"text": "第十八条", "confidence": None}
        with self.client.websocket_connect("/stream", headers=self.headers) as socket:
            socket.send_json({"type": "begin", "hotwords": []})
            socket.send_bytes(b"\0\0" * 1600)
            socket.send_json({"type": "end"})
            self.assertTrue(socket.receive_json()["requiresReview"])


if __name__ == "__main__":
    unittest.main()
