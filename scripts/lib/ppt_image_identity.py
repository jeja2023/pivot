"""读取Docker导出包的配置内容身份，兼容不同镜像存储后端。"""
import hashlib
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], "r") as archive:
    entry = archive.getmember("manifest.json")
    if entry.size > 1024 * 1024:
        raise ValueError("Docker导出清单过大。")
    manifest = json.load(archive.extractfile(entry))
    if len(manifest) != 1:
        raise ValueError("PPT离线发布包只能包含一个平台镜像。")
    config = archive.getmember(manifest[0]["Config"])
    if not config.isfile() or config.size > 10 * 1024 * 1024:
        raise ValueError("Docker镜像配置内容无效。")
    source = archive.extractfile(config).read()
    parsed = json.loads(source)
    print(json.dumps({"configId": "sha256:" + hashlib.sha256(source).hexdigest(), "os": parsed["os"], "architecture": parsed["architecture"]}))
