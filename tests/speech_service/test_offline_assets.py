"""离线资源导入与中文评测计算的确定性回归。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docker" / "speech-service" / "prepare_assets.py"


class OfflineAssetTests(unittest.TestCase):
    def test_model_and_wheel_digest_detect_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "speech-models").mkdir()
            model = root / "speech-models" / "weights.bin"
            model.write_bytes(b"model-test-fixture")
            result = subprocess.run([sys.executable, str(ASSETS), "--root", str(root)], capture_output=True)
            self.assertEqual(result.returncode, 0)
            checked = subprocess.run([sys.executable, str(ASSETS), "--root", str(root), "--verify"], capture_output=True)
            self.assertEqual(checked.returncode, 0)
            model.write_bytes(b"tampered")
            checked = subprocess.run([sys.executable, str(ASSETS), "--root", str(root), "--verify"], capture_output=True)
            self.assertNotEqual(checked.returncode, 0)

    def test_manifest_path_cannot_escape_import_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "speech-assets-manifest.json").write_text(json.dumps({"files": [{"path": "../outside.bin"}]}), "utf-8")
            checked = subprocess.run([sys.executable, str(ASSETS), "--root", str(root), "--verify"], capture_output=True)
            self.assertNotEqual(checked.returncode, 0)

    def test_chinese_character_error_rate_is_not_word_error_rate(self):
        spec = importlib.util.spec_from_file_location("speech_evaluation", ROOT / "scripts" / "evaluate_speech_quality.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.normalized("刑法 第１７条。"), "刑法第17条")
        self.assertEqual(module.edit_distance("刑法第十七条", "刑罚第十七调"), 2)
        self.assertEqual(module.edit_distance("", "错误"), 2)


if __name__ == "__main__":
    unittest.main()
