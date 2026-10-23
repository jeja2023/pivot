"""统一 CPU 中文离线合成服务，密钥认证，仅加载本地校验模型。"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import time
import wave

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro
from misaki.zh import ZHG2P
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
import uvicorn


class Synthesizer:
    def __init__(self, root):
        root = Path(root)
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        if {item['path'] for item in manifest['files']} != {'model.onnx', 'voices.bin', 'MODEL_CARD.md', 'config.json'}:
            raise ValueError('模型物料清单不完整。')
        for item in manifest['files']:
            if item['path'] not in {'model.onnx', 'voices.bin', 'MODEL_CARD.md', 'config.json'}:
                raise ValueError('模型清单包含不允许的路径。')
            with (root / item['path']).open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    raise ValueError('模型摘要校验失败。')
        settings = ort.SessionOptions()
        settings.intra_op_num_threads = 2
        settings.inter_op_num_threads = 1
        session = ort.InferenceSession(str(root / 'model.onnx'), settings, providers=['CPUExecutionProvider'])
        # 固定 SDK 0.4.9 对新版 input_ids 导出错误地使用整数语速；按模型元数据收敛数据类型。
        native_run = session.run
        speed_dtype = np.float32 if next(i.type for i in session.get_inputs() if i.name == 'speed') == 'tensor(float)' else np.int32
        def run_with_model_dtype(outputs, feeds, *args, **kwargs):
            feeds['speed'] = np.asarray(feeds['speed'], dtype=speed_dtype)
            return native_run(outputs, feeds, *args, **kwargs)
        session.run = run_with_model_dtype
        self.model = Kokoro.from_session(session, str(root / 'voices.bin'), vocab_config=str(root / 'config.json'))
        self.g2p = ZHG2P(version='1.1', en_callable=lambda text: self.model.tokenizer.phonemize(text, lang='en-us'))
        self.voices = [voice for voice in self.model.get_voices() if voice.startswith(('zf_', 'zm_'))]
        if not self.voices:
            raise ValueError('模型未包含中文音色。')

    def synthesize(self, text, voice='', speed=1):
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError('朗读文本需要 1 到 2000 个字符。')
        voice = voice or self.voices[0]
        if voice not in self.voices or not 0.5 <= float(speed) <= 2:
            raise ValueError('音色或语速无效。')
        phonemes, _ = self.g2p(text)
        samples, rate = self.model.create(phonemes, voice=voice, speed=float(speed), is_phonemes=True)
        if not len(samples) or len(samples) > rate * 180:
            raise ValueError('合成音频为空或超过 180 秒。')
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(rate)
            audio.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
        return output.getvalue()


def create_app(engine, token):
    if len(token) < 32:
        raise ValueError('语音密钥至少需要 32 字符。')
    executor = ThreadPoolExecutor(max_workers=1)
    state = {'busy': False}

    async def request_handler(request):
        if request.headers.get('origin'):
            return JSONResponse({'error': '语音服务仅接受受控服务器调用。'}, status_code=403)
        if not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + token):
            return JSONResponse({'error': '语音服务身份验证失败。'}, status_code=401)
        if request.method == 'GET':
            return JSONResponse({'available': True, 'voices': engine.voices, 'sampleRate': 24000})
        if state['busy']:
            return JSONResponse({'error': '语音合成忙碌，请稍后重试。'}, status_code=429)
        state['busy'] = True
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 16384:
                    return JSONResponse({'error': '朗读请求超过限制。'}, status_code=413)
            data = json.loads(body)
            started = time.monotonic()
            future = asyncio.get_running_loop().run_in_executor(executor, engine.synthesize, data.get('text'), data.get('voice', ''), data.get('speed', 1))
            # 请求取消不释放正在计算的槽位，避免重叠推理；完成后才清理忙碌标志。
            future.add_done_callback(lambda _: state.update(busy=False))
            audio = await asyncio.wait_for(asyncio.shield(future), 60)
            return Response(audio, media_type='audio/wav', headers={'Cache-Control': 'no-store', 'X-Synthesis-Ms': str(round((time.monotonic() - started) * 1000))})
        except (ValueError, TypeError):
            return JSONResponse({'error': '朗读参数无效或模型无法处理。'}, status_code=422)
        except TimeoutError:
            return JSONResponse({'error': '语音合成超时。'}, status_code=504)
        except Exception:
            return JSONResponse({'error': '离线语音引擎处理失败，请检查模型和运行环境。'}, status_code=502)
        finally:
            if 'future' not in locals():
                state['busy'] = False

    return Starlette(routes=[Route('/speech', request_handler, methods=['GET', 'POST'])])


if __name__ == '__main__':
    engine = Synthesizer(os.environ.get('TTS_MODEL_ROOT', '/models'))
    secret = Path(os.environ.get('TTS_TOKEN_FILE', '/run/secrets/tts_token')).read_text().strip()
    uvicorn.run(create_app(engine, secret), host='0.0.0.0', port=8502, access_log=False, limit_concurrency=8, timeout_keep_alive=5)
