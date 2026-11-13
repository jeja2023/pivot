"""调用固定版本上游模板校验函数，不修改全局模板目录或索引。"""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, "/engine/skill/scripts")
from attribution_guard import require_skill_integrity
import register_template

if __name__ == "__main__":
    require_skill_integrity()
    kind, root = sys.argv[1], Path(sys.argv[2]).resolve()
    workspace = Path(os.environ.get("PIVOT_MASTER_WORKSPACE", "/workspace")).resolve()
    if kind not in {"brand", "style", "layout", "deck"} or not root.is_relative_to(workspace):
        raise ValueError("模板类型或工作区无效。")
    result = register_template._extract_entry(kind, None, root)
    print(json.dumps({"status": "passed", "kind": kind, "template": result}, ensure_ascii=False, default=str))
