"""只在联网准备机运行；记录完整模型与 wheelhouse 摘要供离线导入验收。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

MODELS = {
    "paraformer": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "paraformer-streaming": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online",
    "punctuation": "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    "qwen-asr": "Qwen/Qwen3-ASR-1.7B",
}


def manifest(root):
    output = []
    for file in sorted(root.rglob("*")):
        if file.is_file() and file.name != "speech-assets-manifest.json":
            if not file.resolve().is_relative_to(root.resolve()):
                raise ValueError("模型或依赖文件不能指向资源目录外")
            digest = hashlib.sha256()
            with file.open("rb") as source:
                for chunk in iter(lambda: source.read(1048576), b""):
                    digest.update(chunk)
            output.append({"path": str(file.relative_to(root)).replace("\\", "/"), "bytes": file.stat().st_size, "sha256": digest.hexdigest()})
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("artifacts"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--dependencies-only", action="store_true", help="仅准备 Linux 离线依赖，复用现有模型")
    parser.add_argument("--device", choices=["cpu", "cu126", "cu128"], default="cpu", help="内置服务默认使用 CPU wheels")
    parser.add_argument("--qwen", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    target = root / "speech-assets-manifest.json"
    if args.verify:
        expected = json.loads(target.read_text("utf-8"))
        if not expected.get("files"):
            raise ValueError("离线资源清单为空")
        actual_paths = {name + "/" + record["path"] for name in ["speech-models", "speech-wheelhouse"] for record in manifest(root / name)}
        if actual_paths != {record["path"] for record in expected["files"]}:
            raise ValueError("离线资源存在缺失或未登记的附加文件")
        for record in expected["files"]:
            file = (root / record["path"]).resolve()
            if not file.is_relative_to(root) or not file.is_file():
                raise ValueError("离线资源缺失或越界")
        for record in expected["files"]:
            file = root / record["path"]
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1048576), b""):
                    digest.update(chunk)
            if file.stat().st_size != record["bytes"] or digest.hexdigest() != record["sha256"]:
                raise ValueError("离线资源摘要不匹配")
        print("语音离线资源摘要校验通过")
        return
    if args.download or args.dependencies_only:
        if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
            raise RuntimeError("请在匹配目标架构的 Linux Python 3.12 准备机下载依赖；Windows 开发机可通过 Docker Linux 容器准备")
        wheelhouse = root / "speech-wheelhouse"
        wheelhouse.mkdir(parents=True, exist_ok=True)
        packages = [f"torch==2.8.0+{args.device}", f"torchaudio==2.8.0+{args.device}"]
        offline = subprocess.run([sys.executable, "-m", "pip", "download", "--no-index", "--find-links", str(wheelhouse),
                        "--only-binary=:all:", "--no-deps", "--dest", str(wheelhouse), *packages], capture_output=True)
        if offline.returncode:
            subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--no-deps",
                            "--index-url", f"https://download.pytorch.org/whl/{args.device}",
                            "--dest", str(wheelhouse), *packages], check=True)
        requirements = "requirements-qwen.txt" if args.qwen else "requirements.txt"
        command = [sys.executable, "-m", "pip", "wheel", "--find-links", str(wheelhouse),
                   "--wheel-dir", str(wheelhouse), "-r", str(Path(__file__).with_name(requirements))]
        if args.device == "cpu":
            command.extend(["-c", str(Path(__file__).with_name("requirements-cpu.txt"))])
        else:
            command.extend(packages)
        subprocess.run(command, check=True)
    if args.download:
        from modelscope import snapshot_download
        for name, model in MODELS.items():
            if name == "qwen-asr" and not args.qwen:
                continue
            snapshot_download(model, local_dir=str(root / "speech-models" / name))
    files = []
    for name in ["speech-models", "speech-wheelhouse"]:
        for record in manifest(root / name):
            record["path"] = name + "/" + record["path"]
            files.append(record)
    if not files:
        raise RuntimeError("请先准备模型与 wheelhouse，拒绝生成空验收清单")
    target.write_text(json.dumps({"models": MODELS, "files": files}, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print("语音离线资源清单已生成，请留存并在导入后校验")


if __name__ == "__main__":
    main()
