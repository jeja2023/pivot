"""用固定上游发行包验证模板校验和独立服务任务目录边界。"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if os.name != "posix" or not Path("/engine/manifest.json").is_file():
    raise unittest.SkipTest("模板适配回归需要包含固定上游发行包的Linux容器")
sys.path.insert(0, str(ROOT / "docker" / "ppt-master"))
import runner


class TemplateAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ppt-template-test-", dir=os.environ.get("PPT_SANDBOX_TEST_ROOT"))
        self.workspace = Path(self.temp.name) / "job" / "workspace"
        self.workspace.mkdir(parents=True)
        self.patcher = patch.object(runner, "WORKSPACE", self.workspace)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def copy_template(self, path="selected-template"):
        runner.main({"action": "copy_template", "source": "templates/styles/consulting-decision", "path": path})
        return self.workspace / path

    def test_catalog_templates_validate_in_service_task_directory(self):
        catalog = json.loads((ROOT / "config/ppt-master-templates.json").read_text(encoding="utf-8"))
        for template in catalog["templates"]:
            with self.subTest(template=template["id"]):
                target = template["id"]
                runner.main({"action": "copy_template", "source": template["path"], "path": target})
                result = runner.main({"action": "validate_template", "path": target, "kind": template["kind"]})
                self.assertEqual(result["exitCode"], 0, result.get("stderr"))
                self.assertEqual(json.loads(result["stdout"])["status"], "passed")

    def test_valid_template_can_be_delivered_as_project_archive(self):
        self.copy_template()
        result = runner.main({"action": "deliver_template", "path": "selected-template", "kind": "style"})
        self.assertTrue(result["templateOnly"])
        self.assertEqual(result["packageCheck"]["status"], "passed")
        self.assertTrue((self.workspace / result["projectPath"]).is_file())

    def test_invalid_spec_still_fails_upstream_validation_and_delivery(self):
        root = self.copy_template()
        (root / "templates/design_spec.md").write_text("无效的模板规范", encoding="utf-8")
        result = runner.main({"action": "validate_template", "path": "selected-template", "kind": "style"})
        self.assertNotEqual(result["exitCode"], 0)
        with self.assertRaisesRegex(ValueError, "上游模板校验未通过"):
            runner.main({"action": "deliver_template", "path": "selected-template", "kind": "style"})
        self.assertFalse((self.workspace / "delivery/project.zip").exists())

    def test_adapter_rejects_other_task_and_symlink_escape(self):
        root = self.copy_template()
        other = self.workspace.with_name("workspace-other")
        shutil.copytree(root, other)
        link = self.workspace / "linked-template"
        link.symlink_to(other, target_is_directory=True)
        for target in [other, link]:
            with self.subTest(target=target.name):
                result = runner.run(["/runner/template_adapter.py", "style", str(target)])
                self.assertNotEqual(result["exitCode"], 0)
                self.assertIn("模板类型或工作区无效", result["stderr"])


if __name__ == "__main__":
    unittest.main()
