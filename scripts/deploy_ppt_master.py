#!/usr/bin/env python3
"""一条命令导入、验签、更新或回退PPT制作引擎。"""
import argparse
import fcntl
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from ppt_release_deploy import Deployment


def main():
    parser = argparse.ArgumentParser(description="更新PPT制作引擎，失败恢复原服务；不会构建镜像或在线安装依赖。")
    parser.add_argument("bundle", nargs="?", type=Path, help="已签名离线更新包目录")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="已有Pivot部署目录")
    parser.add_argument("--trust-key", type=Path, help="首次部署时通过可信渠道取得的发布公钥")
    parser.add_argument("--rollback", action="store_true", help="回退上次PPT引擎更新")
    args = parser.parse_args()
    if bool(args.bundle) == args.rollback:
        parser.error("请选择更新包目录或--rollback。")
    try:
        deployment = Deployment(args.root)
        with (deployment.state / "update.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.rollback:
                deployment.rollback()
            else:
                deployment.install(args.bundle, args.trust_key)
    except (Exception, KeyboardInterrupt) as error:
        print("PPT引擎更新未完成：" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
