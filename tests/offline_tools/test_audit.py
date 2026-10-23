"""规则扫描与资源边界回归。"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).resolve().parents[2] / "docker/offline-tools/audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTests(unittest.TestCase):
    def test_import_aliases(self):
        for source in ["import os as o\no.system(value)", "from os import system\nsystem(value)",
                       "import pickle\npickle.load(value)", "import subprocess\nsubprocess.run(value, shell=True)"]:
            self.assertEqual(audit.audit_source(source)["issues_count"], 1)

    def test_shadowed_name(self):
        self.assertEqual(audit.audit_source('def eval(value):\n return value\neval("text")')["issues_count"], 0)

    def test_not_a_safety_verdict(self):
        self.assertEqual(audit.audit_source('print("hello")')["verdict"], 'no_known_findings')

    def test_limits(self):
        for source in ['def broken(', 'value=' + '+'.join(['1'] * 1500)]:
            self.assertEqual(audit.audit_source(source)["status"], 'not_scanned')
        with self.assertRaises(ValueError):
            audit.audit_source('x' * 262145)

    def test_unicode_column(self):
        source = '变量 = 1; eval(value)'
        self.assertEqual(audit.audit_source(source)["issues"][0]["column"], source.index('eval') + 1)


if __name__ == '__main__':
    unittest.main()
