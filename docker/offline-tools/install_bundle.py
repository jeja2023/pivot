#!/usr/bin/env python3
"""在已有 Pivot 部署目录安装经过审核的离线工具包。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys

BASE_FILES = {"image-1.tar", "image-2.tar", "image-3.tar", "docker-compose.tools.yml", "requirements.lock", "verify_bundle.py"}
PROBE = '''
import asyncio
from pathlib import Path
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
async def check():
    token = Path('/run/secrets/offline_tools_token').read_text().strip()
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post('http://127.0.0.1:8501/mcp', json={})
        if response.status_code != 401:
            raise RuntimeError('匿名访问未被拒绝')
    async with streamablehttp_client('http://127.0.0.1:8501/mcp', headers={'Authorization': 'Bearer ' + token}, timeout=5) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            names = {tool.name for tool in (await session.list_tools()).tools}
            if not {'run_ast_audit', 'render_diagram'} <= names:
                raise RuntimeError('工具目录缺少预期工具')
async def main():
    for attempt in range(20):
        try:
            await check()
            return
        except Exception:
            if attempt == 19:
                raise RuntimeError('认证或工具目录检查失败') from None
            await asyncio.sleep(1)
asyncio.run(main())
'''


def run(*args, capture=False, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=capture)


def verify_bundle(bundle):
    manifest = json.loads((bundle / "bom.json").read_text(encoding="utf-8"))
    files = manifest.get("files", [])
    names = {item.get("path") for item in files}
    if manifest.get("version") != 1 or names not in (BASE_FILES, BASE_FILES | {"install_bundle.py"}) or len(files) != len(names):
        raise ValueError("离线包文件清单不正确。")
    if len(manifest.get("images", [])) != 3:
        raise ValueError("离线包镜像清单不正确。")
    for item in files:
        path = bundle / item["path"]
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"物料不是普通文件：{item['path']}")
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        if digest != item.get("sha256"):
            raise ValueError(f"物料摘要不匹配：{item['path']}")
    return manifest


def check_image_metadata(manifest):
    result = run("docker", "info", "--format", "{{.OSType}}/{{.Architecture}}", capture=True)
    os_name, arch = result.stdout.strip().lower().split("/", 1)
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(arch, arch)
    for item in manifest["images"]:
        if item.get("os") != os_name or item.get("architecture") != arch:
            raise ValueError(f"镜像 {item.get('image')} 与 Docker 主机架构不匹配。")
        if not isinstance(item.get("image"), str) or not isinstance(item.get("id"), str):
            raise ValueError("镜像清单缺少名称或 ID。")
        existing = run("docker", "image", "inspect", item["image"], "--format", "{{.Id}}", capture=True, check=False)
        if existing.returncode == 0 and existing.stdout.strip() != item["id"]:
            raise ValueError(f"本机已有不同内容的同名镜像 {item['image']}，请先人工核对。")


def prepare_secret(deploy):
    data = deploy / "data"
    directory = data / "secrets"
    for path in (data, directory):
        if path.is_symlink():
            raise ValueError(f"密钥目录不能是符号链接：{path}")
        path.mkdir(mode=0o700, exist_ok=True)
    target = directory / "offline-tools-token"
    if target.is_symlink():
        raise ValueError("密钥文件不能是符号链接。")
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    except FileExistsError:
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and info.st_mode & 0o007):
            raise ValueError("现有密钥必须是其他用户不可读取的普通文件。")
        can_read = ((getattr(info, "st_uid", -1) == 1000 and info.st_mode & stat.S_IRUSR)
                    or (getattr(info, "st_gid", -1) == 1000 and info.st_mode & stat.S_IRGRP))
        if hasattr(os, "geteuid") and os.geteuid() == 0 and not can_read:
            raise ValueError("现有密钥无法由容器 UID/GID 1000 读取，请检查权限。")
        if len(target.read_text(encoding="utf-8").strip()) < 32:
            raise ValueError("现有密钥少于 32 个字符。")
        print("已保留现有密钥。")
        return
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(secrets.token_hex(32) + "\n")
        if hasattr(os, "chown") and getattr(os, "geteuid", lambda: -1)() == 0:
            os.chown(target, 1000, 1000)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    print("已生成密钥，未在终端显示。")


def check_privileges():
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise ValueError("请通过 sudo 运行，以便为工具容器设置密钥文件所有者。")


def install(bundle, deploy):
    bundle, deploy = bundle.resolve(strict=True), deploy.resolve(strict=True)
    if not bundle.is_dir() or not deploy.is_dir():
        raise ValueError("离线包和 Pivot 部署目录必须是已存在的目录。")
    check_privileges()
    manifest = verify_bundle(bundle)
    print("离线包摘要校验通过；请确保 BOM 和包来自可信渠道。", flush=True)
    check_image_metadata(manifest)
    run("docker", "compose", "version", capture=True)
    run("docker", "network", "inspect", "ai-bridge", capture=True)
    source, destination = bundle / "docker-compose.tools.yml", deploy / "docker-compose.tools.yml"
    if destination.is_symlink():
        raise ValueError("部署目录中的 Compose 文件不能是符号链接。")
    if destination.exists() and destination.read_bytes() != source.read_bytes():
        raise ValueError("部署目录已有不同的工具 Compose 文件，请人工核对，未覆盖。")
    prepare_secret(deploy)
    for index, item in enumerate(manifest["images"], 1):
        run("docker", "load", "-i", str(bundle / f"image-{index}.tar"))
        actual = run("docker", "image", "inspect", item["image"], "--format", "{{.Id}}", capture=True)
        if actual.stdout.strip() != item["id"]:
            raise ValueError(f"导入后的镜像 ID 不匹配：{item['image']}")
    if not destination.exists():
        with destination.open("xb") as file, source.open("rb") as original:
            shutil.copyfileobj(original, file)
    compose = ("docker", "compose", "--project-directory", str(deploy), "-f", str(destination))
    run(*compose, "config", "--quiet")
    run(*compose, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "240")
    run(*compose, "exec", "-T", "offline-tools", "python", "-c", PROBE, capture=True)
    run(*compose, "ps")
    print("服务已启动，认证及工具目录检查通过。请用 Pivot 最高管理员账号登记 http://offline-tools:8501/mcp，并通过受控渠道录入密钥文件。")


def main():
    parser = argparse.ArgumentParser(description="一键安装离线工具服务；不会修改现有密钥或不同的 Compose 文件。")
    parser.add_argument("bundle", type=Path, help="已审核离线包目录")
    parser.add_argument("deploy", type=Path, help="已有 Pivot 部署目录")
    args = parser.parse_args()
    try:
        install(args.bundle, args.deploy)
    except subprocess.CalledProcessError:
        print("安装失败：Docker 命令未成功，请检查 Docker、网络及工具容器日志。", file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"安装失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
