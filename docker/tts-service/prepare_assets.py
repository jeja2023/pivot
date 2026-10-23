"""仅在联网准备机下载固定发布制品，记录摘要；运行时不下载。"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2] / 'artifacts/tts-models'
MODEL_REVISION = '01e7505bd6a7a2ac4975463114c3a7650a9f7218'
FILES = {
    'model.onnx': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.1-zh.int8.onnx',
    'voices.bin': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.1-zh.bin',
    'config.json': f'https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/resolve/{MODEL_REVISION}/config.json',
    'MODEL_CARD.md': f'https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/raw/{MODEL_REVISION}/README.md',
}


def download(item):
    name, url = item
    target = ROOT / name
    if not target.exists():
        with urllib.request.urlopen(url, timeout=60) as response, target.with_suffix(target.suffix + '.part').open('wb') as output:
            while chunk := response.read(1048576):
                output.write(chunk)
        target.with_suffix(target.suffix + '.part').rename(target)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': name, 'url': url, 'sha256': digest, 'bytes': target.stat().st_size}


if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        files = list(pool.map(download, FILES.items()))
    (ROOT / 'manifest.json').write_text(json.dumps({'model': 'Kokoro-v1.1-zh-int8', 'license': 'Apache-2.0', 'files': files}, indent=2), encoding='utf-8')
    print('中文合成模型、音色与来源摘要已准备，请通过可信通道保管并交付清单。')
