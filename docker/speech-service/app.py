"""独立语音网关：有界内存、鉴权、单模型锁、双遍识别与无录音留存。"""
import asyncio
import base64
from contextlib import asynccontextmanager
import hmac
import io
import json
import os
import re
import wave

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

MAX_BYTES = 640044


async def inference(function, *args):
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # 线程中的推理不可强杀；等它结束再释放会话锁，避免另一路同时使用缓存。
        await task
        raise


def authorize(value):
    secret = os.environ.get("SPEECH_API_KEY", "")
    return bool(len(secret) >= 24 and hmac.compare_digest(str(value).encode("utf-8"), f"Bearer {secret}".encode("utf-8")))


def hotwords(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("热词参数无效")
    if any(not isinstance(word, str) or not word.strip() or len(word) > 40 for word in value):
        raise ValueError("热词参数无效")
    return list(dict.fromkeys(word.strip() for word in value))


def decode_audio(encoded):
    if not isinstance(encoded, str) or len(encoded) > 853392:
        raise ValueError("录音超出限制")
    raw = bytearray(base64.b64decode(encoded, validate=True))
    try:
        if len(raw) < 3244 or len(raw) > MAX_BYTES:
            raise ValueError("录音超出限制")
        with wave.open(io.BytesIO(raw), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000 or source.getnframes() > 320000:
                raise ValueError("仅支持 16kHz 单声道短录音")
            return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    finally:
        raw[:] = b"\0" * len(raw)


def create_app(engine_factory=None):
    @asynccontextmanager
    async def lifespan(app):
        if len(os.environ.get("SPEECH_API_KEY", "")) < 24:
            raise RuntimeError("请设置至少 24 字符的语音服务密钥")
        if engine_factory is None:
            from engine import SpeechEngine
            app.state.engine = SpeechEngine()
        else:
            app.state.engine = engine_factory()
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health(request: Request):
        if not authorize(request.headers.get("authorization")):
            raise HTTPException(401, "需要有效服务凭据")
        return {"ready": True, "backend": app.state.engine.backend, "streaming": app.state.engine.streaming}

    @app.post("/transcribe")
    async def transcribe(request: Request):
        if not authorize(request.headers.get("authorization")):
            raise HTTPException(401, "需要有效服务凭据")
        body = bytearray()
        try:
            async for part in request.stream():
                body.extend(part)
                if len(body) > 900000:
                    raise HTTPException(413, "录音超出限制")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("请求必须是对象")
            if payload.get("language", "zh-CN") != "zh-CN":
                raise ValueError("当前部署仅启用中文识别")
            words = hotwords(payload.get("hotwords", []))
            samples = decode_audio(payload.get("audioBase64"))
            payload = None
        except (ValueError, TypeError, wave.Error):
            raise HTTPException(400, "录音或热词参数无效") from None
        finally:
            body[:] = b"\0" * len(body)
        engine = app.state.engine
        if not engine.lock.acquire(blocking=False):
            samples.fill(0)
            raise HTTPException(429, "语音模型繁忙")

        def work():
            try:
                return engine.transcribe(samples, words)
            finally:
                samples.fill(0)
                engine.lock.release()
        # 客户端断开不提前释放模型锁；已提交的 GPU 工作完成后才允许下一次推理。
        try:
            return await asyncio.shield(asyncio.to_thread(work))
        except asyncio.CancelledError:
            raise
        except Exception:
            raise HTTPException(503, "语音模型推理失败") from None

    @app.websocket("/stream")
    async def streaming(socket: WebSocket):
        if not authorize(socket.headers.get("authorization")) or not app.state.engine.streaming:
            await socket.close(code=1008)
            return
        await socket.accept()
        engine = app.state.engine
        claimed = False
        audio = bytearray()
        cache = {}
        preview = ""
        pending = bytearray()
        words = []
        try:
            while True:
                packet = await asyncio.wait_for(socket.receive(), timeout=60)
                if packet["type"] == "websocket.disconnect":
                    break
                if packet.get("bytes") is not None:
                    chunk = packet["bytes"]
                    if not claimed or len(chunk) % 2 or len(audio) + len(chunk) > 640000:
                        raise ValueError("语音分片无效")
                    audio.extend(chunk)
                    pending.extend(chunk)
                    while len(pending) >= 19200:
                        samples = np.frombuffer(bytes(pending[:19200]), dtype="<i2").astype(np.float32) / 32768
                        del pending[:19200]
                        preview += await inference(engine.partial, samples, cache)
                        samples.fill(0)
                        await socket.send_json({"type": "partial", "text": preview})
                    continue
                control = json.loads(packet.get("text", ""))
                if control.get("type") == "begin" and not claimed:
                    words = hotwords(control.get("hotwords", []))
                    if not engine.lock.acquire(blocking=False):
                        raise ValueError("语音模型繁忙")
                    claimed = True
                    audio.clear(); pending.clear(); cache = {}; preview = ""
                elif control.get("type") == "end" and claimed:
                    tail = np.frombuffer(bytes(pending), dtype="<i2").astype(np.float32) / 32768
                    try:
                        preview += await inference(engine.partial, tail, cache, True)
                        samples = np.frombuffer(bytes(audio), dtype="<i2").astype(np.float32) / 32768
                        try:
                            result = await inference(engine.transcribe, samples, words)
                        finally:
                            samples.fill(0)
                        # 两遍识别中的数字存在分歧时留给用户确认，不擅自选取金额、日期或条款编号。
                        numbers = lambda value: re.findall(r"[0-9零〇一二两三四五六七八九十百千万亿]+", value)
                        before, after = numbers(preview), numbers(result.get("text", ""))
                        if (before or after) and before != after:
                            result["requiresReview"] = True
                    finally:
                        tail.fill(0)
                        audio[:] = b"\0" * len(audio); audio.clear()
                        pending[:] = b"\0" * len(pending); pending.clear()
                        cache.clear(); engine.lock.release(); claimed = False
                    await socket.send_json({"type": "final", **result})
                else:
                    raise ValueError("语音控制状态无效")
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except Exception:
            try:
                await socket.send_json({"type": "error", "text": "", "message": "语音服务繁忙或输入无效"})
                await socket.close(code=1011)
            except Exception:
                pass
        finally:
            audio[:] = b"\0" * len(audio); pending[:] = b"\0" * len(pending); cache.clear()
            if claimed:
                engine.lock.release()

    return app


app = create_app()
