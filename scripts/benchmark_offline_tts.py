"""在实际目标主机上记录合成耗时及可复验音频摘要；不把合成成功当作发音质量通过。"""
import argparse
import hashlib
import io
import json
import platform
from pathlib import Path
import statistics
import time
import urllib.request
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--endpoint', default='http://127.0.0.1:8502/speech')
parser.add_argument('--token-file', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
samples = ['重庆银行行长正在审阅项目报告。', '请核对账号二零二六及百分之五的统计数据。', '项目 API 接口已经完成测试，请在下周一提交。']
token = Path(args.token_file).read_text().strip()
results = []
for text in samples:
    request = urllib.request.Request(args.endpoint, data=json.dumps({'text': text}, ensure_ascii=True).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=70) as response:
        audio = response.read(9 * 1024 * 1024 + 1)
    elapsed = time.monotonic() - started
    with wave.open(io.BytesIO(audio), 'rb') as stream:
        duration = stream.getnframes() / stream.getframerate()
    results.append({'sample': text, 'seconds': round(elapsed, 3), 'audioSeconds': round(duration, 3), 'realTimeFactor': round(elapsed / duration, 3), 'sha256': hashlib.sha256(audio).hexdigest()})
report = {'at': time.time(), 'system': platform.platform(), 'processor': platform.processor(), 'results': results,
          'medianSeconds': statistics.median(item['seconds'] for item in results),
          'manualQualityRequired': ['多音字', '数字与账号', '中英混读', '音色自然度', '输出设备与打断']}
Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('合成性能与音频摘要已记录，发音质量仍需人工试听。')
