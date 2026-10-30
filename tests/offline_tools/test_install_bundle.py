import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[2] / "docker" / "offline-tools" / "install_bundle.py"
spec = importlib.util.spec_from_file_location("install_bundle", MODULE_PATH)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.deploy = self.root / "pivot"
        self.bundle.mkdir()
        self.deploy.mkdir()
        files = []
        for name in sorted(installer.BASE_FILES):
            content = name.encode()
            (self.bundle / name).write_bytes(content)
            files.append({"path": name, "sha256": hashlib.sha256(content).hexdigest()})
        self.images = [{"image": f"test-image:{i}", "id": f"sha256:{i}", "os": "linux", "architecture": "amd64"} for i in range(1, 4)]
        (self.bundle / "bom.json").write_text(json.dumps({"version": 1, "files": files, "images": self.images}), encoding="utf-8")
        self.loaded = {}
        self.commands = []
        patcher = patch.object(installer, "check_privileges")
        self.addCleanup(patcher.stop)
        self.mock_privileges = patcher.start()

    def fake_run(self, *args, capture=False, check=True):
        self.commands.append(args)
        class Result:
            returncode = 0
            stdout = ""
        result = Result()
        if args[1] == "info":
            result.stdout = "linux/x86_64\n"
        elif args[1:3] == ("image", "inspect"):
            result.stdout = self.loaded.get(args[3], "")
            result.returncode = 0 if result.stdout else 1
        elif args[1] == "load":
            index = int(Path(args[3]).stem[-1]) - 1
            self.loaded[self.images[index]["image"]] = self.images[index]["id"]
        return result

    def test_installs_and_reuses_secret_without_printing_it(self):
        output = io.StringIO()
        with patch.object(installer, "run", side_effect=self.fake_run), contextlib.redirect_stdout(output):
            installer.install(self.bundle, self.deploy)
            secret = (self.deploy / "data/secrets/offline-tools-token").read_text().strip()
            installer.install(self.bundle, self.deploy)
        self.assertEqual(len(secret), 64)
        self.assertNotIn(secret, output.getvalue())
        self.assertEqual((self.deploy / "data/secrets/offline-tools-token").read_text().strip(), secret)
        self.assertEqual((self.deploy / "docker-compose.tools.yml").read_bytes(), (self.bundle / "docker-compose.tools.yml").read_bytes())
        self.assertTrue(any("--wait" in call and "--pull" in call for call in self.commands))

    def test_tampered_bundle_does_not_call_docker(self):
        (self.bundle / "image-1.tar").write_text("changed", encoding="utf-8")
        with patch.object(installer, "run", side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, "摘要"):
                installer.install(self.bundle, self.deploy)
        self.assertFalse(self.commands)
        self.assertFalse((self.deploy / "data").exists())

    def test_existing_compose_and_different_image_are_not_overwritten(self):
        target = self.deploy / "docker-compose.tools.yml"
        target.write_text("existing", encoding="utf-8")
        with patch.object(installer, "run", side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, "Compose"):
                installer.install(self.bundle, self.deploy)
            self.assertEqual(target.read_text(), "existing")
            self.assertFalse((self.deploy / "data").exists())
            target.unlink()
            self.loaded[self.images[0]["image"]] = "sha256:other"
            with self.assertRaisesRegex(ValueError, "同名镜像"):
                installer.install(self.bundle, self.deploy)
        self.assertFalse((self.deploy / "data").exists())


if __name__ == "__main__":
    unittest.main()
