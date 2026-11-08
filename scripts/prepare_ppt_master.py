"""固定版本完整技能发行包准备器；仅在构建阶段获取文件，不修改上游内容。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "config/ppt-master-engine.json").read_text(encoding="utf-8"))


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True, encoding="utf-8").strip()


def prepare(checkout: Path | None, output: Path) -> dict:
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("输出目录已有内容，请使用新的版本目录；不会覆盖现有发行包。")
    with tempfile.TemporaryDirectory(prefix="pivot-ppt-master-build-") as temporary:
        staging = Path(temporary)
        if checkout is None:
            checkout = staging / "upstream"
            subprocess.check_call(["git", "clone", "--filter=blob:none", "--no-checkout", LOCK["repository"], str(checkout)])
            subprocess.check_call(["git", "-C", str(checkout), "fetch", "--depth=1", "origin", LOCK["revision"]])
        revision = run("git", "-C", str(checkout), "rev-parse", LOCK["revision"] + "^{commit}")
        if revision != LOCK["revision"]:
            raise ValueError("上游提交不匹配。")
        tree = run("git", "-C", str(checkout), "rev-parse", revision + ":" + LOCK["skillPath"])
        if tree != LOCK["tree"]:
            raise ValueError("上游技能树不匹配固定版本。")
        archive = staging / "source.tar"
        subprocess.check_call(["git", "-C", str(checkout), "archive", "--format=tar", "--output", str(archive), revision, LOCK["skillPath"]])
        skill = output / "skill"
        skill.mkdir()
        prefix = LOCK["skillPath"] + "/"
        with tarfile.open(archive) as source:
            for member in source:
                if member.isdir():
                    continue
                if not member.isfile() or not member.name.startswith(prefix):
                    raise ValueError("上游发行包含非普通文件或越界路径。")
                relative = PurePosixPath(member.name[len(prefix):])
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("上游发行路径无效。")
                target = skill.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as handle, target.open("xb") as destination:
                    shutil.copyfileobj(handle, destination)
        for name in LOCK["requiredFiles"]:
            if not (skill / name).is_file():
                raise ValueError("发行包缺少必需文件：" + name)
        files = []
        for file in sorted(skill.rglob("*"), key=lambda item: item.relative_to(skill).as_posix()):
            if file.is_file():
                data = file.read_bytes()
                files.append({"path": file.relative_to(skill).as_posix(), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        digest = hashlib.sha256(json.dumps(files, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if digest != LOCK["contentDigest"]:
            raise ValueError("上游完整发行包摘要不匹配。")
        manifest = {"schemaVersion": 1, "repository": LOCK["repository"], "revision": revision, "tree": tree,
                    "skillVersion": LOCK["skillVersion"], "contentDigest": digest, "fileCount": len(files), "files": files}
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        subprocess.check_call([os.sys.executable, str(skill / "scripts/attribution_guard.py")], cwd=output)
        return {key: value for key, value in manifest.items() if key != "files"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="准备固定版本的完整 PPT Master 技能发行包。")
    parser.add_argument("--checkout", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/ppt-master-runtime")
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.checkout, arguments.output), ensure_ascii=False))
