"""在已有单活Linux部署中切换PPT引擎，失败恢复原配置。"""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import tempfile

from ppt_release_bundle import atomic_write, check_contract, fail, regular, verify_bundle


class Deployment:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if self.root.resolve() != self.root or not self.root.is_dir() or re.search(r"[\n\r$,:]", str(self.root)):
            fail("部署目录必须是无链接、无特殊分隔符的现有绝对目录。")
        self.env_file = self.root / ".env"
        regular(self.env_file, 2 * 1024**2)
        self.state = self.root / "data" / "ppt-master-deployment"
        for directory in [self.root / "data", self.state, self.state / "versions", self.state / "snapshots"]:
            if directory.is_symlink():
                fail("部署数据目录不能经过符号链接。")
            directory.mkdir(exist_ok=True, mode=0o755)
        self.overlay = self.root / "docker-compose.ppt-master.yml"
        self.pending = self.state / "pending.json"
        self.key = self.state / "publisher-public.pem"

    def run(self, args, timeout=240, check=True):
        environment = {key: value for key, value in os.environ.items() if key not in {"COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR"}}
        result = subprocess.run(args, cwd=self.root, env=environment, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            message = "Docker操作未成功，请检查镜像、运行权限和服务日志。"
            for line in reversed(result.stderr.splitlines()):
                try:
                    value = json.loads(line)
                    if isinstance(value, dict) and value.get("message"):
                        message = value["message"]
                        break
                except ValueError:
                    pass
            fail(message)
        return result

    def files(self):
        source = self.env_file.read_text(encoding="utf-8")
        separator = ":"
        for key, value in re.findall(r"^\s*(COMPOSE_FILE|COMPOSE_PATH_SEPARATOR)\s*=\s*(.*?)\s*$", source, re.M):
            if key == "COMPOSE_PATH_SEPARATOR":
                separator = value.strip("\"'")
        if separator not in {":", ";"}:
            fail("Compose文件分隔符配置无效。")
        matches = re.findall(r"^\s*COMPOSE_FILE\s*=\s*(.*?)\s*$", source, re.M)
        names = matches[-1].strip("\"'").split(separator) if matches else ["docker-compose.yml"]
        files = []
        for name in names:
            if not name or "$" in name:
                fail("请先将COMPOSE_FILE中的动态变量改为明确文件路径。")
            file = Path(name) if Path(name).is_absolute() else self.root / name
            regular(file, 2 * 1024**2)
            if file.resolve() != file.absolute():
                fail("Compose文件不能经过符号链接。")
            files.append(str(file))
        return files, separator

    def compose(self, files, *arguments, timeout=240):
        command = ["docker", "compose", "--project-directory", str(self.root)]
        for file in files:
            command.extend(["-f", str(file)])
        return self.run(command + list(arguments), timeout=timeout)

    def probe(self, files, action, token=None, timeout=420):
        arguments = ["exec", "-T", "pivot", "node", "scripts/preflight_ppt_master.js", action]
        if token:
            arguments.append(token)
        try:
            result = self.compose(files, *arguments, timeout=timeout)
        except ValueError:
            if action == "contract":
                fail("无法读取Pivot部署合同，请确认主服务已启动并更新到配套版本。")
            raise
        for line in reversed(result.stdout.splitlines()):
            try:
                value = json.loads(line)
                if isinstance(value, dict) and ("ready" in value or "deploymentProtocol" in value):
                    return value
            except ValueError:
                pass
        fail("当前Pivot缺少配套部署检查程序，请先更新主应用镜像。")

    def prerequisites(self):
        if os.name != "posix" or os.geteuid() != 0:
            fail("请在Linux生产主机通过sudo执行，以配置任务目录所有者和Docker用户组。")
        if os.environ.get("DOCKER_HOST") not in {None, "", "unix:///var/run/docker.sock"}:
            fail("此工具面向本机Docker节点，不接受远程Docker执行端。")
        context = json.loads(self.run(["docker", "context", "inspect"]).stdout)[0]
        if context["Endpoints"]["docker"]["Host"] != "unix:///var/run/docker.sock":
            fail("请选用本机/var/run/docker.sock对应的Docker上下文。")
        socket = Path("/var/run/docker.sock")
        if not stat.S_ISSOCK(socket.stat().st_mode):
            fail("本机Docker socket不可用。")
        self.run(["openssl", "version"])
        self.run(["docker", "compose", "version"])
        return socket.stat().st_gid

    def trust(self, key):
        if self.key.exists():
            regular(self.key, 16384)
            if key and Path(key).read_bytes() != self.key.read_bytes():
                fail("生产已登记不同发布公钥；更新包不能自行替换信任根。")
        else:
            if not key:
                fail("首次部署请使用--trust-key指定通过可信渠道取得的发布公钥。")
            regular(Path(key), 16384)
            result = self.run(["openssl", "pkey", "-pubin", "-in", str(Path(key).absolute()), "-text", "-noout"])
            bits = re.search(r"Public-Key:\s*\((\d+) bit\)", result.stdout)
            if "Modulus:" not in result.stdout or not bits or int(bits[1]) < 2048:
                fail("发布公钥必须是至少2048位RSA公钥。")
            atomic_write(self.key, Path(key).read_bytes(), 0o644)

    def snapshot(self, files, old_image):
        directory = self.state / "snapshots" / secrets.token_hex(16)
        directory.mkdir(mode=0o700)
        (directory / "previous.env").write_bytes(self.env_file.read_bytes())
        os.chmod(directory / "previous.env", 0o600)
        had_overlay = self.overlay.exists()
        if had_overlay:
            regular(self.overlay, 2 * 1024**2)
            (directory / "previous-compose.json").write_bytes(self.overlay.read_bytes())
        installed = self.state / "installed.json"
        if installed.exists():
            regular(installed, 16384)
            (directory / "previous-installed.json").write_bytes(installed.read_bytes())
        metadata = {"files": files, "image": old_image, "overlay": had_overlay, "installed": installed.exists(), "envMode": stat.S_IMODE(self.env_file.stat().st_mode)}
        (directory / "snapshot.json").write_text(json.dumps(metadata), encoding="utf-8")
        return directory

    def restore(self, directory, token):
        directory = Path(directory)
        if directory.parent != self.state / "snapshots" or not re.fullmatch(r"[a-f0-9]{32}", directory.name) or directory.is_symlink():
            fail("恢复快照目录无效。")
        metadata = json.loads((directory / "snapshot.json").read_text(encoding="utf-8"))
        atomic_write(self.env_file, (directory / "previous.env").read_bytes(), metadata["envMode"])
        if metadata["overlay"]:
            atomic_write(self.overlay, (directory / "previous-compose.json").read_bytes(), 0o644)
        elif self.overlay.exists():
            if self.overlay.is_symlink():
                fail("恢复目标Compose不能是符号链接。")
            self.overlay.unlink()
        pin = directory / "restore-image.json"
        pin.write_text(json.dumps({"services": {"pivot": {"image": metadata["image"]}}}), encoding="utf-8")
        self.compose(metadata["files"] + [str(pin)], "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180")
        self.probe(metadata["files"], "unquiesce", token)
        installed = self.state / "installed.json"
        if metadata.get("installed"):
            atomic_write(installed, (directory / "previous-installed.json").read_bytes())
        elif installed.exists():
            installed.unlink()

    def recover(self):
        if not self.pending.exists():
            return
        regular(self.pending, 16384)
        pending = json.loads(self.pending.read_text(encoding="utf-8"))
        if pending.get("phase") == "prepared":
            metadata = json.loads((Path(pending["snapshot"]) / "snapshot.json").read_text(encoding="utf-8"))
            self.probe(metadata["files"], "unquiesce", pending["token"])
        else:
            self.restore(pending["snapshot"], pending["token"])
        self.pending.unlink()
        print("已恢复上次中断前的服务和配置。", flush=True)

    def make_overlay(self, directory, image, group, user):
        work = self.root / "data" / "ppt-master-workspaces"
        if work.is_symlink():
            fail("任务目录不能是符号链接。")
        work.mkdir(mode=0o700, exist_ok=True)
        uid, gid = [int(item) for item in user.split(":")]
        os.chown(work, uid, gid)
        def bind(source, target, readonly=False):
            return {"type": "bind", "source": str(source), "target": str(target), "read_only": readonly, "bind": {"create_host_path": False}}
        return {"services": {"pivot": {"group_add": [str(group)], "environment": {
            "PIVOT_PPT_MASTER_ENABLED": "true", "PIVOT_PPT_MASTER_IMAGE": image,
            "PIVOT_CAPABILITY_WORKER_ENABLED": "true", "PIVOT_CAPABILITY_WORKER_DOCKER": "docker",
            "PIVOT_PPT_MASTER_WORKSPACE_DIR": str(work),
            "PIVOT_PPT_MASTER_TRUSTED_MANIFEST": "/app/ppt-master-deployment/worker-trust.json",
            "PIVOT_PPT_MASTER_SIGNING_PUBLIC_KEY_FILE": "/app/ppt-master-deployment/publisher-public.pem"},
            "volumes": [bind("/var/run/docker.sock", "/var/run/docker.sock"), bind(work, work), bind(directory, "/app/ppt-master-deployment", True)]}}}

    def available_image(self, manifest):
        identities = [manifest["image"]["id"], manifest["image"]["configId"]]
        for identity in dict.fromkeys(identities):
            result = self.run(["docker", "image", "inspect", identity], check=False)
            if result.returncode:
                continue
            imported = json.loads(result.stdout)[0]
            if imported.get("Id") not in identities or imported.get("Os") != manifest["image"]["os"] or imported.get("Architecture") != manifest["image"]["architecture"]:
                fail("本机镜像身份或平台与已签名声明不符。")
            return imported["Id"]
        return None

    def install(self, bundle, trust_key=None):
        group = self.prerequisites()
        self.recover()
        self.trust(trust_key)
        files, separator = self.files()
        config = json.loads(self.compose(files, "config", "--format", "json").stdout)
        service = config.get("services", {}).get("pivot", {})
        user = service.get("user", "1000:1000")
        if not re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", user):
            fail("生产Pivot必须配置明确的非root数字UID:GID。")
        application = self.probe(files, "contract")
        platform = json.loads(self.run(["docker", "info", "--format", "{{json .}}"]).stdout)
        with tempfile.TemporaryDirectory(prefix="staging-", dir=self.state) as temporary:
            staging = Path(temporary)
            manifest = verify_bundle(Path(bundle).resolve(strict=True), self.key, staging)
            check_contract(manifest, application, platform)
            print("发布签名、文件摘要、平台与应用合同已通过。", flush=True)
            installed_file = self.state / "installed.json"
            identities = [manifest["image"]["id"], manifest["image"]["configId"]]
            if installed_file.exists() and json.loads(installed_file.read_text(encoding="utf-8")).get("releaseId") == manifest["releaseId"] and service.get("environment", {}).get("PIVOT_PPT_MASTER_IMAGE") in identities:
                self.probe(files, "smoke")
                print("此版本已部署，实际运行检查通过，无需重复切换。", flush=True)
                return
            image = self.available_image(manifest)
            if image is None:
                self.run(["docker", "image", "load", "--input", str(staging / "ppt-master.tar")], timeout=1200)
                image = self.available_image(manifest)
            if image is None:
                fail("导入后的实际镜像身份与签名声明不符。")
            directory = self.state / "versions" / (manifest["releaseId"] + "-" + secrets.token_hex(4))
            directory.mkdir(mode=0o755)
            for name in ["worker-trust.json", "release.json"]:
                shutil.copyfile(staging / name, directory / name)
                os.chmod(directory / name, 0o644)
            shutil.copyfile(self.key, directory / "publisher-public.pem")
            overlay = self.make_overlay(directory, image, group, user)
            candidate = directory / "compose.json"
            candidate.write_text(json.dumps(overlay, ensure_ascii=False, indent=2), encoding="utf-8")
            base = [file for file in files if Path(file) != self.overlay]
            self.compose(base + [str(candidate)], "config", "--quiet")
            ids = self.compose(files, "ps", "--quiet", "pivot").stdout.strip().splitlines()
            if len(ids) != 1:
                fail("更新工具要求已有单活Pivot服务正在运行。")
            running = json.loads(self.run(["docker", "inspect", ids[0]]).stdout)[0]
            recorded = running.get("Config", {}).get("Labels", {}).get("com.docker.compose.project.config_files", "")
            actual_files = recorded.split(",") if recorded else []
            extras = [file for file in actual_files if file not in files]
            if recorded and ([file for file in actual_files if file in files] != files or any(not Path(file).is_relative_to(self.state / "snapshots") or Path(file).name != "restore-image.json" for file in extras)):
                fail("运行中的Compose文件与部署配置不一致，请先在.env的COMPOSE_FILE中登记原有叠加项。")
            old_image = running["Image"]
            snapshot = self.snapshot(files, old_image)
            token = secrets.token_hex(16)
            pending = {"snapshot": str(snapshot), "token": token, "phase": "prepared"}
            atomic_write(self.pending, json.dumps(pending).encode())
            try:
                self.probe(files, "quiesce", token)
                pending["phase"] = "switching"
                atomic_write(self.pending, json.dumps(pending).encode())
                atomic_write(self.overlay, candidate.read_bytes(), 0o644)
                selection = separator.join([str(Path(file).relative_to(self.root)) if Path(file).is_relative_to(self.root) else file for file in base] + [self.overlay.name])
                source = self.env_file.read_text(encoding="utf-8")
                line = "COMPOSE_FILE=" + json.dumps(selection)
                source = re.sub(r"^\s*COMPOSE_FILE\s*=.*$", "", source, flags=re.M).rstrip() + "\n" + line + "\n"
                atomic_write(self.env_file, source.encode(), stat.S_IMODE(self.env_file.stat().st_mode))
                updated = base + [str(self.overlay)]
                # 引擎更新使用当前正在运行的主镜像；不借机切换同名应用标签。
                pin = snapshot / "restore-image.json"
                pin.write_text(json.dumps({"services": {"pivot": {"image": old_image}}}), encoding="utf-8")
                self.compose(updated + [str(pin)], "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180")
                self.probe(updated, "smoke")
                self.probe(updated, "unquiesce", token)
                atomic_write(self.state / "installed.json", json.dumps({"releaseId": manifest["releaseId"], "image": image, "previousSnapshot": str(snapshot)}, indent=2).encode())
                self.pending.unlink()
            except BaseException:
                try:
                    self.recover()
                    print("更新未通过，已保留或恢复原配置和原服务。", flush=True)
                except BaseException:
                    print("原服务恢复尚未通过；已保留恢复记录，再次执行更新命令会先恢复。", flush=True)
                raise
        print("PPT引擎已更新，签名、实际运行与任务目录双向检查通过。", flush=True)

    def rollback(self):
        self.prerequisites()
        self.recover()
        installed = json.loads((self.state / "installed.json").read_text(encoding="utf-8"))
        files, _ = self.files()
        token = secrets.token_hex(16)
        atomic_write(self.pending, json.dumps({"snapshot": installed["previousSnapshot"], "token": token, "phase": "prepared"}).encode())
        try:
            self.probe(files, "quiesce", token)
        except BaseException:
            self.probe(files, "unquiesce", token)
            self.pending.unlink()
            raise
        atomic_write(self.pending, json.dumps({"snapshot": installed["previousSnapshot"], "token": token, "phase": "switching"}).encode())
        self.recover()
        print("已回退至上次PPT更新前的配置与服务。", flush=True)
