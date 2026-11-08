"""PPT发布包与更新回退的实际签名、文件和事务回归。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
from ppt_release_bundle import check_contract, verify_bundle
from ppt_release_deploy import Deployment

FIXTURE = r"""
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {sign}=require('./scripts/lib/ppt_master_release');
const root=process.argv[1],key=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const image='sha256:'+'a'.repeat(64),configId='sha256:'+'f'.repeat(64),engine=require('./config/ppt-master-engine.json');
fs.mkdirSync(path.join(root,'bundle'));
fs.writeFileSync(path.join(root,'public.pem'),key.publicKey.export({format:'pem',type:'spki'}));
fs.writeFileSync(path.join(root,'private.pem'),key.privateKey.export({format:'pem',type:'pkcs8'}));
const worker=sign({version:1,images:[image,configId].map(image=>({image,commands:['python,/runner/runner.py']}))},key.privateKey);
fs.writeFileSync(path.join(root,'bundle','worker-trust.json'),JSON.stringify(worker));
fs.writeFileSync(path.join(root,'bundle','ppt-master.tar'),'本机发布包签名测试');
const files=['ppt-master.tar','worker-trust.json'].map(name=>{const b=fs.readFileSync(path.join(root,'bundle',name));return{name,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};});
const manifest=sign({schemaVersion:1,releaseId:'b'.repeat(32),createdAt:new Date().toISOString(),deploymentProtocol:1,pivotVersion:'0.7.133',image:{id:image,configId,sourceTag:'ppt-master:6.8.0',os:'linux',architecture:'amd64'},engine:{revision:engine.revision,contentDigest:engine.contentDigest,protocolVersion:engine.protocolVersion,skillVersion:engine.skillVersion},files},key.privateKey);
fs.writeFileSync(path.join(root,'bundle','release.json'),JSON.stringify(manifest));
"""


class ReleaseFixture:
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="ppt-release-fixture-")
        subprocess.run(["node", "-e", FIXTURE, cls.fixture.name], cwd=ROOT, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ppt-release-test-")
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        shutil.copytree(Path(self.fixture.name) / "bundle", self.bundle)
        self.key = Path(self.fixture.name) / "public.pem"
        self.staging = self.root / "staging"
        self.staging.mkdir()

    def tearDown(self):
        self.temporary.cleanup()


class BundleTests(ReleaseFixture, unittest.TestCase):
    def test_actual_release_signature_and_immutable_snapshot(self):
        manifest = verify_bundle(self.bundle, self.key, self.staging)
        self.assertEqual(manifest["image"]["id"], "sha256:" + "a" * 64)
        original = (self.staging / "ppt-master.tar").read_bytes()
        (self.bundle / "ppt-master.tar").write_bytes(b"after-snapshot")
        self.assertEqual((self.staging / "ppt-master.tar").read_bytes(), original)

    def test_modified_image_is_rejected_before_import(self):
        (self.bundle / "ppt-master.tar").write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "摘要不一致"):
            verify_bundle(self.bundle, self.key, self.staging)

    def test_modified_deployment_metadata_invalidates_signature(self):
        file = self.bundle / "release.json"
        manifest = json.loads(file.read_bytes())
        manifest["image"]["id"] = "sha256:" + "c" * 64
        file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "签名无效"):
            verify_bundle(self.bundle, self.key, self.staging)

    @unittest.skipIf(os.name == "nt", "链接权限由Linux回归验证")
    def test_symlink_material_is_rejected(self):
        file = self.bundle / "ppt-master.tar"
        file.rename(self.bundle / "real.tar")
        file.symlink_to(self.bundle / "real.tar")
        with self.assertRaisesRegex(ValueError, "普通文件"):
            verify_bundle(self.bundle, self.key, self.staging)

    def test_engine_platform_and_deployment_protocol_must_match(self):
        manifest = verify_bundle(self.bundle, self.key, self.staging)
        app = {"deploymentProtocol": 1, "engine": manifest["engine"]}
        check_contract(manifest, app, {"OSType": "linux", "Architecture": "x86_64"})
        for application, platform in [({"deploymentProtocol": 0, "engine": app["engine"]}, {"OSType": "linux", "Architecture": "amd64"}),
                                      ({"deploymentProtocol": 1, "engine": {}}, {"OSType": "linux", "Architecture": "amd64"}),
                                      (app, {"OSType": "linux", "Architecture": "arm64"})]:
            with self.assertRaises(ValueError):
                check_contract(manifest, application, platform)


class FakeDeployment(Deployment):
    def __init__(self, root, engine):
        super().__init__(root)
        self.events = []
        self.engine = engine
        self.bad_smoke = False
        self.busy = False

    def prerequisites(self):
        return 999

    def run(self, args, **kwargs):
        self.events.append(args)
        if args[0] == 'openssl':
            return subprocess.run(args, check=True, capture_output=True, text=True)
        if args[:3] == ["docker", "image", "load"]:
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(args, 0, json.dumps([{"Id": "sha256:" + "a" * 64, "Os": "linux", "Architecture": "amd64"}]), "")
        if args[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(args, 0, json.dumps([{"Image": "sha256:" + "d" * 64}]), "")
        return subprocess.CompletedProcess(args, 0, json.dumps({"OSType": "linux", "Architecture": "amd64"}), "")

    def compose(self, files, *args, **kwargs):
        self.events.append(list(args))
        if args[:1] == ("config",):
            return subprocess.CompletedProcess(args, 0, json.dumps({"services": {"pivot": {"user": "1000:1000", "image": "pivot:fixture"}}}), "")
        if args[:1] == ("ps",):
            return subprocess.CompletedProcess(args, 0, "existing-container", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    def probe(self, files, action, token=None, **kwargs):
        self.events.append(["probe", action])
        if action == "contract":
            return {"deploymentProtocol": 1, "engine": self.engine}
        if action == "quiesce" and self.busy:
            raise ValueError("仍有运行中的任务")
        if action == "smoke" and self.bad_smoke:
            raise ValueError("目录映射核对失败")
        return {"ready": True}


@unittest.skipIf(os.name != "posix", "Linux部署事务单独在容器内执行")
class DeploymentTests(ReleaseFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.deploy = self.root / "deploy"
        self.deploy.mkdir()
        (self.deploy / ".env").write_text('BUSINESS_SECRET="保留原值"\n', encoding="utf-8")
        (self.deploy / "docker-compose.yml").write_text('{"services":{"pivot":{"image":"pivot:fixture"}}}')
        self.original = (self.deploy / ".env").read_bytes()
        self.engine = json.loads((self.bundle / "release.json").read_bytes())["engine"]
        self.deployment = FakeDeployment(self.deploy, self.engine)

    def test_success_preserves_business_config_and_adds_controller_mounts(self):
        with patch("ppt_release_deploy.os.chown"):
            self.deployment.install(self.bundle, self.key)
        self.assertIn(self.original.strip(), (self.deploy / ".env").read_bytes())
        overlay = json.loads(self.deployment.overlay.read_bytes())["services"]["pivot"]
        self.assertEqual(overlay["environment"]["PIVOT_PPT_MASTER_IMAGE"], "sha256:" + "a" * 64)
        self.assertEqual(overlay["group_add"], ["999"])
        self.assertEqual(overlay["volumes"][1]["source"], overlay["volumes"][1]["target"])
        self.assertFalse(self.deployment.pending.exists())
        self.assertFalse(any(event[:3] == ["docker", "image", "load"] for event in self.deployment.events))
        installed = json.loads((self.deployment.state / "installed.json").read_bytes())
        pin = json.loads((Path(installed["previousSnapshot"]) / "restore-image.json").read_bytes())
        self.assertEqual(pin["services"]["pivot"]["image"], "sha256:" + "d" * 64)

    def test_failed_smoke_restores_previous_env_and_does_not_leave_overlay(self):
        self.deployment.bad_smoke = True
        with patch("ppt_release_deploy.os.chown"), self.assertRaisesRegex(ValueError, "映射"):
            self.deployment.install(self.bundle, self.key)
        self.assertEqual((self.deploy / ".env").read_bytes(), self.original)
        self.assertFalse(self.deployment.overlay.exists())
        self.assertFalse(self.deployment.pending.exists())
        self.assertIn(["probe", "unquiesce"], self.deployment.events)

    def test_busy_engine_keeps_running_service_without_restart(self):
        self.deployment.busy = True
        with patch("ppt_release_deploy.os.chown"), self.assertRaisesRegex(ValueError, "运行中"):
            self.deployment.install(self.bundle, self.key)
        self.assertFalse(any(event and event[0] == "up" for event in self.deployment.events))
        self.assertEqual((self.deploy / ".env").read_bytes(), self.original)

    def test_untrusted_package_cannot_replace_registered_publisher(self):
        self.deployment.trust(self.key)
        wrong = self.root / "other-public.pem"
        wrong.write_text("另一发布者")
        with self.assertRaisesRegex(ValueError, "不同发布公钥"):
            self.deployment.trust(wrong)

    def test_explicit_rollback_restores_original_config(self):
        with patch("ppt_release_deploy.os.chown"):
            self.deployment.install(self.bundle, self.key)
        self.deployment.rollback()
        self.assertEqual((self.deploy / ".env").read_bytes(), self.original)
        self.assertFalse(self.deployment.overlay.exists())

    def test_interrupted_preparation_only_releases_gate_without_restart(self):
        snapshot = self.deployment.snapshot(self.deployment.files()[0], "sha256:" + "d" * 64)
        self.deployment.pending.write_text(json.dumps({"snapshot": str(snapshot), "token": "e" * 32, "phase": "prepared"}))
        self.deployment.recover()
        self.assertFalse(any(event and event[0] == "up" for event in self.deployment.events))
        self.assertFalse(self.deployment.pending.exists())

    def test_interrupted_switch_restores_previous_installed_record(self):
        with patch("ppt_release_deploy.os.chown"):
            self.deployment.install(self.bundle, self.key)
        installed = self.deployment.state / "installed.json"
        previous = installed.read_bytes()
        snapshot = self.deployment.snapshot(self.deployment.files()[0], "sha256:" + "d" * 64)
        installed.write_text('{"releaseId":"incomplete"}')
        self.deployment.pending.write_text(json.dumps({"snapshot": str(snapshot), "token": "e" * 32, "phase": "switching"}))
        self.deployment.recover()
        self.assertEqual(installed.read_bytes(), previous)

    def test_classic_storage_uses_only_the_signed_config_identity(self):
        class Classic(FakeDeployment):
            def run(self, args, **kwargs):
                if args[:3] == ["docker", "image", "inspect"]:
                    if args[3] == "sha256:" + "a" * 64:
                        return subprocess.CompletedProcess(args, 1, "", "未保存索引身份")
                    return subprocess.CompletedProcess(args, 0, json.dumps([{"Id": "sha256:" + "f" * 64, "Os": "linux", "Architecture": "amd64"}]), "")
                return super().run(args, **kwargs)
        classic = Classic(self.deploy, self.engine)
        with patch("ppt_release_deploy.os.chown"):
            classic.install(self.bundle, self.key)
        actual = json.loads(classic.overlay.read_bytes())["services"]["pivot"]["environment"]["PIVOT_PPT_MASTER_IMAGE"]
        self.assertEqual(actual, "sha256:" + "f" * 64)

    def test_missing_image_is_imported_once_and_checked_again(self):
        class Loading(FakeDeployment):
            loaded = False
            def run(self, args, **kwargs):
                if args[:3] == ["docker", "image", "inspect"] and not self.loaded:
                    self.events.append(args)
                    return subprocess.CompletedProcess(args, 1, "", "未预置")
                if args[:3] == ["docker", "image", "load"]:
                    self.loaded = True
                return super().run(args, **kwargs)
        loading = Loading(self.deploy, self.engine)
        with patch("ppt_release_deploy.os.chown"):
            loading.install(self.bundle, self.key)
        self.assertEqual(sum(event[:3] == ["docker", "image", "load"] for event in loading.events), 1)

    def test_wrong_local_image_identity_cannot_replace_current_config(self):
        class Wrong(FakeDeployment):
            def run(self, args, **kwargs):
                if args[:3] == ["docker", "image", "inspect"]:
                    return subprocess.CompletedProcess(args, 0, json.dumps([{"Id": "sha256:" + "9" * 64, "Os": "linux", "Architecture": "amd64"}]), "")
                return super().run(args, **kwargs)
        wrong = Wrong(self.deploy, self.engine)
        with self.assertRaisesRegex(ValueError, "身份或平台"):
            wrong.install(self.bundle, self.key)
        self.assertEqual((self.deploy / ".env").read_bytes(), self.original)
        self.assertFalse(wrong.overlay.exists())


if __name__ == "__main__":
    unittest.main()
