"""准备源码开发专用的 CPU 语音虚拟环境，不修改系统 Python。"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]


def main():
    # Windows pip 旧版会按系统 GBK 读取带中文注释的依赖文件。
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="仅检查项目虚拟环境与 CPU 语音包")
    parser.add_argument("--offline", action="store_true", help="仅使用本机已准备的 wheelhouse")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("请使用 Python 3.12 运行本脚本")
    environment = ROOT / ".venv-speech"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    wheels = ROOT / "artifacts" / ("speech-wheelhouse-windows" if os.name == "nt" else "speech-wheelhouse")
    requirements = ROOT / "docker" / "speech-service"
    if not args.check:
        if not python.is_file():
            venv.EnvBuilder(with_pip=True).create(environment)
        wheels.mkdir(parents=True, exist_ok=True)
        packages = ["torch==2.8.0+cpu", "torchaudio==2.8.0+cpu"]
        cached = subprocess.run([str(python), "-m", "pip", "download", "--no-index", "--find-links", str(wheels),
                                 "--only-binary=:all:", "--no-deps", "--dest", str(wheels), *packages], capture_output=True)
        if cached.returncode:
            if args.offline:
                raise RuntimeError("缺少当前系统/Python 3.12 对应的 PyTorch CPU 离线安装包")
            subprocess.run([str(python), "-m", "pip", "download", "--only-binary=:all:", "--no-deps", "--dest", str(wheels),
                            "--index-url", "https://download.pytorch.org/whl/cpu", *packages], check=True)
        command = [str(python), "-m", "pip", "install", "--find-links", str(wheels),
                   "-r", str(requirements / "requirements.txt"), "-c", str(requirements / "requirements-cpu.txt")]
        if args.offline:
            command.append("--no-index")
        subprocess.run(command, check=True)
    if not python.is_file():
        raise RuntimeError("尚未准备 .venv-speech，请先运行 python scripts/setup_speech_runtime.py")
    subprocess.run([str(python), "-m", "pip", "check"], check=True)
    probe = "import sys,json,torch,torchaudio,numpy,fastapi,uvicorn,funasr,silero_vad,transformers,websockets; assert sys.version_info[:2]==(3,12); assert torch.version.cuda is None; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cpuOnly':True,'environmentReady':True}))"
    subprocess.run([str(python), "-c", probe], check=True)
    print(json.dumps({"runtime": str(python), "models": str(ROOT / "data" / "speech-models"),
                      "next": "重新启动 Pivot 或在语音设置中保存并应用，系统自动使用项目语音环境"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
