"""离线主机只需标准 Python 即可核对交付物料，不加载业务配置或依赖。"""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
manifest = json.loads((root / 'bom.json').read_text(encoding='utf-8'))
expected = {'image-1.tar', 'image-2.tar', 'image-3.tar', 'docker-compose.tools.yml', 'requirements.lock', 'verify_bundle.py'}
names = {item['path'] for item in manifest['files']}
if manifest.get('version') != 1 or names not in (expected, expected | {'install_bundle.py'}) or len(manifest['files']) != len(names):
    raise SystemExit('物料清单不完整或包含非法路径。')
for item in manifest['files']:
    file = root / item['path']
    if file.is_symlink() or not file.is_file():
        raise SystemExit('物料文件类型不正确。')
    with file.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != item['sha256']:
        raise SystemExit('物料摘要不匹配：' + item['path'])
print('全部离线物料摘要校验通过。')
