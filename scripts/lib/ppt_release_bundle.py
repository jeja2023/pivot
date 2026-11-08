"""验证PPT离线包的发布签名、固定合同及文件快照。"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


def fail(message):
    raise ValueError(message)


def regular(file, maximum=None):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or maximum is not None and info.st_size > maximum:
        fail("发布文件必须是大小受限的普通文件：" + file.name)
    return info


def parse_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("发布JSON不能包含重复字段。")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def verify_signed(value, key_file, temporary):
    payload = dict(value)
    signature = payload.pop("signature", "")
    if payload.pop("signatureAlgorithm", None) != "RSA-SHA256":
        fail("离线包必须使用RSA-SHA256发布签名。")
    if not isinstance(signature, str) or len(signature) > 4096:
        fail("发布签名格式无效。")
    try:
        decoded = base64.b64decode(signature, validate=True)
    except (ValueError, TypeError):
        fail("发布签名编码无效。")
    body, sig = temporary / "signed-body.json", temporary / "signature.bin"
    body.write_bytes(canonical(payload))
    sig.write_bytes(decoded)
    result = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(key_file), "-signature", str(sig), str(body)], capture_output=True)
    if result.returncode:
        fail("离线包签名无效或不属于已登记的发布者。")
    return payload


def snapshot(source, target, maximum):
    regular(source, maximum)
    digest, total = hashlib.sha256(), 0
    # 保留同一打开文件的读取与校验，后续仅导入私有暂存副本，防止原路径被替换。
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as original, target.open("xb") as output:
        if not stat.S_ISREG(os.fstat(original.fileno()).st_mode):
            fail("离线物料不是普通文件。")
        while chunk := original.read(4 * 1024 * 1024):
            total += len(chunk)
            if total > maximum:
                fail("离线物料超过允许大小。")
            digest.update(chunk)
            output.write(chunk)
    return total, digest.hexdigest()


def verify_bundle(bundle, key_file, temporary):
    regular(bundle / "release.json", 262144)
    release_data = (bundle / "release.json").read_bytes()
    manifest = verify_signed(parse_json(release_data), key_file, temporary)
    expected = {"schemaVersion", "releaseId", "createdAt", "deploymentProtocol", "pivotVersion", "image", "engine", "files"}
    if set(manifest) != expected or manifest["schemaVersion"] != 1 or manifest["deploymentProtocol"] != 1 or not re.fullmatch(r"[a-f0-9]{32}", str(manifest["releaseId"])):
        fail("离线包版本或部署合同无效。")
    image = manifest["image"]
    if set(image) != {"id", "configId", "sourceTag", "os", "architecture"} or any(not re.fullmatch(r"sha256:[a-f0-9]{64}", str(image[key])) for key in ["id", "configId"]) or image["os"] != "linux" or image["architecture"] != "amd64":
        fail("当前离线包仅支持完整镜像ID及Linux/amd64平台。")
    files = manifest["files"]
    if not isinstance(files, list) or len(files) != 2 or {item.get("name") for item in files} != {"ppt-master.tar", "worker-trust.json"}:
        fail("离线包必须包含固定名称ppt-master.tar及Worker签名清单。")
    for item in files:
        if set(item) != {"name", "bytes", "sha256"} or type(item["bytes"]) is not int or not re.fullmatch(r"[a-f0-9]{64}", str(item["sha256"])):
            fail("离线物料声明格式无效。")
        maximum = 20 * 1024**3 if item["name"] == "ppt-master.tar" else 262144
        size, digest = snapshot(bundle / item["name"], temporary / item["name"], maximum)
        if size != item["bytes"] or digest != item["sha256"]:
            fail("离线物料摘要不一致：" + item["name"])
    worker = verify_signed(parse_json((temporary / "worker-trust.json").read_bytes()), key_file, temporary)
    expected_images = [{"image": identity, "commands": ["python,/runner/runner.py"]} for identity in dict.fromkeys([image["id"], image["configId"]])]
    if worker != {"version": 1, "images": expected_images}:
        fail("PPT专用签名清单的镜像或执行入口不匹配。")
    (temporary / "release.json").write_bytes(release_data)
    return manifest


def check_contract(release, application, platform):
    engine = application.get("engine", {})
    if application.get("deploymentProtocol") != release["deploymentProtocol"]:
        fail("当前Pivot尚不支持此部署协议，请先更新Pivot主镜像。")
    if any(engine.get(key) != release["engine"].get(key) for key in ["revision", "contentDigest", "protocolVersion", "skillVersion"]):
        fail("PPT引擎固定版本与当前Pivot不兼容，请使用配套发布包。")
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.get("Architecture"), platform.get("Architecture"))
    if platform.get("OSType") != release["image"]["os"] or architecture != release["image"]["architecture"]:
        fail("PPT镜像与生产Docker节点的操作系统或架构不匹配。")


def atomic_write(file, data, mode=0o600):
    if file.is_symlink():
        fail("更新目标不能是符号链接：" + file.name)
    descriptor, name = tempfile.mkstemp(prefix=file.name + ".new-", dir=file.parent)
    temporary = Path(name)
    os.chmod(temporary, mode)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file)
        if os.name == "posix":
            directory = os.open(file.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
