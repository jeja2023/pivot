"""仅在镜像构建期安装固定摘要的离线模型；生产进程不会访问下载地址。"""
import hashlib
import os
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip"
MODEL_SHA256 = "3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba"


def main():
    destination = Path(os.environ.get("PIVOT_SPEECH_BUILD_PATH", "/opt/pivot-speech/model"))
    if destination.exists():
        raise ValueError("模型目录已存在，拒绝覆盖。")
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / "model.zip"
        digest = hashlib.sha256()
        with urllib.request.urlopen(MODEL_URL, timeout=120) as response, archive.open("wb") as output:
            size = 0
            while True:
                chunk = response.read(1048576)
                if not chunk:
                    break
                size += len(chunk)
                if size > 67108864:
                    raise ValueError("模型下载大小超出限制。")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != MODEL_SHA256:
            raise ValueError("模型摘要不匹配，拒绝构建。")
        root = Path(temporary) / "extracted"
        with zipfile.ZipFile(archive) as source:
            if sum(item.file_size for item in source.infolist()) > 268435456:
                raise ValueError("模型解压大小超出限制。")
            for item in source.infolist():
                target = (root / item.filename).resolve()
                if not target.is_relative_to(root.resolve()) or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError("模型压缩包路径无效。")
            source.extractall(root)
        model = root / "vosk-model-small-cn-0.22"
        if not (model / "am" / "final.mdl").is_file():
            raise ValueError("模型文件不完整。")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(model), str(destination))
    print("离线中文语音模型安装并校验完成。")


if __name__ == "__main__":
    main()
