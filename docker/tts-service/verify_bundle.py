"""在仅有 Python 标准库的离线主机验证办公扩展包。"""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
expected = {'tts-image.tar', 'docker-compose.tts.yml', 'requirements.lock', '部署说明.md', 'verify_bundle.py',
            'tts-models/model.onnx', 'tts-models/voices.bin', 'tts-models/config.json', 'tts-models/MODEL_CARD.md', 'tts-models/manifest.json'}
manifest = json.loads((root / 'bom.json').read_text(encoding='utf-8'))
if manifest.get('version') != 1 or len(manifest['files']) != len(expected):
    raise SystemExit('办公扩展清单不完整。')
for item in manifest['files']:
    if item['path'] not in expected:
        raise SystemExit('物料路径非法或重复。')
    expected.remove(item['path'])
    file = root / item['path']
    if file.is_symlink() or not file.is_file() or file.resolve().parent not in {root, root / 'tts-models'}:
        raise SystemExit('物料文件类型或目录无效。')
    with file.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != item['sha256']:
        raise SystemExit('物料摘要不匹配：' + item['path'])
print('全部办公扩展物料校验通过。')
