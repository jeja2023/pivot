"""仅在隔离验收卷中验证真实PPT部署、更新与回退。"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

sys.path.insert(0, "/source/scripts/lib")
from ppt_release_bundle import atomic_write
from ppt_release_deploy import Deployment


def main():
    root, image, network, api, first, second = sys.argv[1:]
    root = Path(root)
    if not str(root).startswith("/var/lib/docker/volumes/ppt-deploy-") or root.name != "deploy":
        raise ValueError("验收只能写入本次隔离Docker卷。")
    root.mkdir(mode=0o755)
    for name in ["data", "uploads", "logs", "downloads"]:
        directory = root / name
        directory.mkdir(mode=0o755)
        os.chown(directory, 1000, 1000)
    env = {"NODE_ENV": "production", "DATABASE_URL": "postgresql://pivot_test@postgres:5432/postgres", "DEFAULT_ADMIN_PASSWORD": "Qa9!" + secrets.token_hex(20),
           "JWT_SECRET": secrets.token_hex(32), "DATA_ENCRYPTION_KEY": secrets.token_hex(32), "PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET": secrets.token_hex(32),
           "PIVOT_HOOK_AUDIT_FINGERPRINT_SECRET": secrets.token_hex(32), "PIVOT_PPT_MASTER_ENABLED": "false", "PIVOT_CAPABILITY_WORKER_ENABLED": "false"}
    (root / ".env").write_text("\n".join(key + "=" + value for key, value in env.items()) + "\n")
    initial = (root / ".env").read_bytes()
    service = {"image": image, "container_name": api, "user": "1000:1000", "env_file": [".env"], "read_only": True, "cap_drop": ["ALL"],
               "security_opt": ["no-new-privileges:true"], "tmpfs": ["/tmp:size=512m,mode=1777"], "networks": ["acceptance"],
               "volumes": [str(root / name) + ":/app/" + name for name in ["data", "uploads", "logs", "downloads"]],
               "healthcheck": {"test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], "interval": "2s", "timeout": "3s", "retries": 60}}
    (root / "docker-compose.yml").write_text(json.dumps({"services": {"pivot": service}, "networks": {"acceptance": {"external": True, "name": network}}}))
    deployment = Deployment(root)
    base, _ = deployment.files()
    deployment.compose(base, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
    deployment.install(first, Path(first) / "publisher-public.pem")
    first_overlay, first_env = deployment.overlay.read_bytes(), (root / ".env").read_bytes()
    files, _ = deployment.files()
    first_probe = deployment.probe(files, "smoke")
    assert first_probe["workspaceRoundtrip"]
    inspection = json.loads(deployment.run(["docker", "inspect", api]).stdout)[0]
    first_container = inspection["Id"]
    assert inspection["HostConfig"]["GroupAdd"]
    assert any(mount["Destination"] == "/var/run/docker.sock" for mount in inspection["Mounts"])

    class Fault(Deployment):
        def probe(self, files, action, token=None, **kwargs):
            result = super().probe(files, action, token, **kwargs)
            if action == "smoke":
                raise ValueError("验收注入：实际探针通过后模拟部署检查失败")
            return result
    try:
        Fault(root).install(second)
        raise AssertionError("故障注入没有触发回退")
    except ValueError as error:
        assert "验收注入" in str(error)
    assert deployment.overlay.read_bytes() == first_overlay
    assert (root / ".env").read_bytes() == first_env
    assert deployment.probe(deployment.files()[0], "smoke")["image"] == first_probe["image"]

    deployment.install(second)
    upgraded = deployment.probe(deployment.files()[0], "smoke")
    assert upgraded["image"] != first_probe["image"]
    deployment.rollback()
    assert deployment.overlay.read_bytes() == first_overlay
    assert deployment.probe(deployment.files()[0], "smoke")["image"] == first_probe["image"]

    token = secrets.token_hex(16)
    files, _ = deployment.files()
    snapshot = deployment.snapshot(files, json.loads(deployment.run(["docker", "inspect", api]).stdout)[0]["Image"])
    deployment.probe(files, "quiesce", token)
    atomic_write(deployment.pending, json.dumps({"snapshot": str(snapshot), "token": token, "phase": "switching"}).encode())
    atomic_write(deployment.overlay, json.dumps({"services": {"pivot": {"image": "sha256:" + "0" * 64}}}).encode(), 0o644)
    deployment.recover()
    assert deployment.probe(deployment.files()[0], "smoke")["image"] == first_probe["image"]
    assert not (root / "data" / "ppt-master-maintenance.json").exists()
    assert initial.strip() in (root / ".env").read_bytes()
    report = {"passed": True, "productionDeployed": False, "actualContainerExecution": True, "firstInstall": True, "socketAndWorkspaceMounts": True,
              "signedImageIdentity": first_probe["image"], "upgradedImageIdentity": upgraded["image"], "realImageUpgrade": True,
              "failedSmokeRestoredOriginal": True, "explicitRollback": True, "interruptedSwitchRecovered": True, "businessConfigPreserved": True,
              "applicationImage": image, "initialContainerId": first_container}
    (root.parent / "deployment-report.json").write_text(json.dumps(report, indent=2))
    print("PPT实际部署验收通过：" + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
