"""受限 Python 源码规则扫描；从不执行被检查代码。"""
import ast

MAX_BYTES = 262144
MAX_NODES = 20000
MAX_DEPTH = 100
RULES = {
    "eval": "动态执行字符串", "exec": "动态执行代码", "compile": "动态编译代码",
    "__import__": "动态导入模块", "os.system": "执行系统命令", "os.popen": "打开命令管道",
    "subprocess.Popen": "创建子进程", "subprocess.call": "执行外部命令",
    "subprocess.run": "执行外部命令", "subprocess.check_call": "执行外部命令",
    "subprocess.check_output": "执行外部命令", "pickle.load": "反序列化数据",
    "pickle.loads": "反序列化数据", "marshal.loads": "反序列化代码", "yaml.load": "加载可能不安全的 YAML",
}


def audit_source(source_code, file_name="inline.py"):
    if not isinstance(source_code, str) or not source_code.strip():
        raise ValueError("源码不能为空。")
    if len(source_code.encode("utf-8")) > MAX_BYTES:
        raise ValueError("源码超过 256 KiB 限制。")
    if not isinstance(file_name, str) or len(file_name) > 120:
        raise ValueError("文件显示名称过长。")
    try:
        tree = ast.parse(source_code)
    except (SyntaxError, RecursionError, MemoryError, ValueError) as error:
        return {"status": "not_scanned", "reason": "源码无法解析或超过解析限制。", "error_type": type(error).__name__}
    stack, count = [(tree, 0)], 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            return {"status": "not_scanned", "reason": "语法树超过节点或深度限制。"}
        stack.extend((child, depth + 1) for child in ast.iter_child_nodes(node))
    visitor = AuditVisitor(source_code.splitlines())
    visitor.visit(tree)
    return {"status": "completed", "file_name": file_name, "scanned_nodes": count,
            "coverage": "有限静态规则，不构成安全或合规证明；不执行数据流与跨文件分析。",
            "verdict": "findings" if visitor.issues else "no_known_findings",
            "issues_count": len(visitor.issues), "issues": visitor.issues}


class AuditVisitor(ast.NodeVisitor):
    def __init__(self, lines):
        self.lines, self.scopes, self.issues = lines, [{}], []

    def resolve(self, node):
        if isinstance(node, ast.Name):
            for scope in reversed(self.scopes):
                if node.id in scope:
                    return scope[node.id]
            return node.id
        if isinstance(node, ast.Attribute):
            root = self.resolve(node.value)
            return f"{root}.{node.attr}" if root else ""
        return ""

    def visit_Import(self, node):
        for alias in node.names:
            self.scopes[-1][alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.scopes[-1][alias.asname or alias.name] = f"{node.module}.{alias.name}"

    def visit_Assign(self, node):
        self.visit(node.value)
        for target in node.targets:
            if isinstance(target, ast.Name):
                self.scopes[-1][target.id] = self.resolve(node.value)

    def visit_FunctionDef(self, node):
        self.scopes[-1][node.name] = ""
        for value in node.decorator_list + node.args.defaults + [v for v in node.args.kw_defaults if v]:
            self.visit(value)
        # Python 函数局部名的绑定覆盖整个作用域，而不是仅覆盖定义后的语句。
        local = {arg.arg: "" for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs}
        if node.args.vararg:
            local[node.args.vararg.arg] = ""
        if node.args.kwarg:
            local[node.args.kwarg.arg] = ""
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                local[child.id] = ""
        self.scopes.append(local)
        for statement in node.body:
            self.visit(statement)
        self.scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Call(self, node):
        target = self.resolve(node.func)
        if target in RULES:
            byte_prefix = self.lines[node.lineno - 1].encode("utf-8")[:node.col_offset]
            self.issues.append({"line": node.lineno, "column": len(byte_prefix.decode("utf-8")) + 1,
                                "target": target, "risk": "high", "description": RULES[target]})
        self.generic_visit(node)
