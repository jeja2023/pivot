"""使用固定 Git 归档构建最小 Docker 上下文，避免扫描宿主缓存和开发目录。"""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "config/ppt-master-engine.json").read_text(encoding="utf-8"))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="构建固定版本完整PPT引擎。", formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--tag", default="ppt-master:" + LOCK["skillVersion"], help="执行镜像名称和标签，可指定其他镜像仓库。")
    arguments = parser.parse_args()
    lock = LOCK
    manifest_path = ROOT / "artifacts/ppt-master-runtime/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["revision"] != lock["revision"] or manifest["contentDigest"] != lock["contentDigest"]:
        raise ValueError("准备好的发行包与固定摘要不一致。")
    with tempfile.TemporaryDirectory(prefix="ppt-master-context-") as temporary:
        archive = Path(temporary) / "source.tar"
        context = Path(temporary) / "context.tar"
        subprocess.check_call(["git", "-C", str(arguments.checkout), "archive", "--format=tar", "--output", str(archive), lock["revision"], lock["skillPath"]])
        with tarfile.open(context, "w") as output:
            prefix = lock["skillPath"] + "/"
            with tarfile.open(archive) as source:
                for member in source:
                    if not member.isfile():
                        continue
                    if not member.name.startswith(prefix) or ".." in Path(member.name).parts:
                        raise ValueError("固定归档路径无效。")
                    target = tarfile.TarInfo("artifacts/ppt-master-runtime/skill/" + member.name[len(prefix):])
                    target.size = member.size; target.mode = 0o644; target.mtime = 0
                    output.addfile(target, source.extractfile(member))
            files = ["config/ppt-master-engine.json", "docker/ppt-master/Dockerfile", "docker/ppt-master/runner.py", "docker/ppt-master/tool_catalog.py", "docker/ppt-master/template_adapter.py", "docker/ppt-master/requirements.lock", "docker/ppt-master/preview-requirements.lock"]
            files += [file.relative_to(ROOT).as_posix() for file in sorted((ROOT / "docker/ppt-master").glob("native_*.py"))]
            for name in files:
                data = (ROOT / name).read_bytes()
                entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644; output.addfile(entry, io.BytesIO(data))
            data = manifest_path.read_bytes(); entry = tarfile.TarInfo("artifacts/ppt-master-runtime/manifest.json"); entry.size = len(data); output.addfile(entry, io.BytesIO(data))
        with context.open("rb") as stream:
            subprocess.check_call(["docker", "build", "-f", "docker/ppt-master/Dockerfile", "-t", arguments.tag, "-"], cwd=ROOT, stdin=stream)
