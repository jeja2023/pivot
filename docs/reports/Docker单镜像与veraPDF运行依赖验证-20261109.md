# Docker 单镜像与 veraPDF 运行依赖验证

日期：2026-11-09。本文归档本轮 Docker 安装失败修复、slim 依赖复查、veraPDF 探测修复和最终单镜像打包的实际证据，供 [v0.7.144 发布说明](../releases/v0.7.144-Docker单镜像完整打包与运行依赖修复.md)引用。

## 检查对象

最终功能阶段在 Windows Docker Desktop 的 Linux x64 环境实际执行 `docker build -t pivot:latest .`，构建成功。镜像身份为 `sha256:a911b5c699fea9f4ea11d628886b8c146984ef2c31abfd0bdd802c1b24204581`，应用版本0.7.143，默认命令 `node server/index.js`、默认用户 `node`。本次启用的0.7.144为后续源码和文档版本，尚未据此重新构建制品。

验证以镜像中的实际文件和调用链为准，没有因为包管理器能解析名称就认定全部功能可用。镜像体积仅用于确认归档对象：前期 `pivot.tar` 为704.57 MiB，归档清单确认为完整主应用；后续722.8 MiB归档曾同时包含主应用和独立 Runner，不能混作同一制品的体积对比。slim 切换和压缩层大小也不能替代依赖完整性验证。

## 根因与最终修复

| 问题 | 触发与证据 | 最终处理 |
| --- | --- | --- |
| SQLite 下载失败 | npm已指定镜像，但清单和锁文件写死 `codeload.github.com` 源码 URL，下载出现 ECONNRESET | 精确使用npm发布包12.11.1并更新摘要，保留源码编译和查询自检 |
| Git/rg遗漏 | 原样终端Runner允许命令，slim主镜像却缺二进制；实际返回 `spawn git ENOENT`、`spawn rg ENOENT` | 工具和协议脚本统一纳入默认主镜像，独立Runner改为可选兼容包装 |
| veraPDF误报不可用 | 高负载下5秒探测失败；同镜像实际CLI能运行，冷启动版本查询曾耗时约17秒 | 改为30秒探测、5秒失败缓存，独立超时分类和页面35秒等待 |

旧完整版 `node:22-bookworm` 镜像可运行Git 2.39.5，未检出rg。Git缺失是切换slim后暴露的退化，rg是同时发现的已有打包缺口。最终镜像安装Git 2.39.5与ripgrep 13.0.0，未关闭原有隔离或授权校验。

## 最终单镜像实测

| 范围 | 实际结果 |
| --- | --- |
| 完整默认构建 | 通过；SQLite/生产模块、Python/Vosk、qpdf、Java、veraPDF、PostgreSQL客户端、Docker CLI、字体以及Git/rg与协议脚本自检通过 |
| `tests/dockerfile-runtime-contract.test.js`、`tests/terminal-capability-worker-runner.test.js`、`tests/capability-worker-runner.test.js`、`tests/verapdf-health.test.js` | 合计28项通过，无失败或跳过；新增契约在旧实现上会失败 |
| `tests/pdf-tools-browser.test.js` | 3项通过，覆盖能力等待时间、页面既有交互和表单提交 |
| 终端真实调用 | 使用实际 `buildWorkerDockerArguments` 生成参数，UID65532、禁网、只读根、cap-drop、no-new-privileges；Git status/diff/log/show、rg文本检索/文件枚举、Node和Python共8项通过，测试工作区已清理 |
| veraPDF延迟启动 | 在真实CLI前加入6秒延迟后探测成功，约14.8秒，超过旧5秒阈值；并发探测共用结果 |
| 实际PDF/A调用 | 生成XML验证报告，普通测试PDF正确判为非合规；没有把进程成功当作PDF/A合规 |
| 生产模块与SQLite | 镜像内模块加载和实际内存查询通过 |
| 文件与许可 | 相关文件ESLint、diff空白、许可及测试位置检查通过；Debian Git/ripgrep copyright随镜像保留 |

最终功能阶段的 `npm run check` 因其他并行改动中的 `client/chat/apps-workbench-presentations.js` 超过字节体积基线而停止（109213 > 109198）。本次没有修改该基线，也未将这次失败写成全仓检查通过。后续文档同步检查须与该历史功能阶段结果分开记录。

## v0.7.144 文档与版本同步复核

- 通过既有 `npm run version:sync` 同步版本，`package.json`、锁文件顶层和根包版本均为0.7.144；服务端 `getAppVersion()` 返回 `v0.7.144`。README徽章、最新版本标题、页尾当前版本及设计基线一致，历史版本条目保留。
- 检查9份相关文档中的508个本地文件链接，未发现缺失目标；UTF-8文本检查和diff空白检查通过，换行按仓库规则统一为LF。发布说明和部署指引明确旧镜像/归档不会随源码版本改变。
- 本次 `npm run check` 已通过文本、架构、配置、迁移和开发规范基础检查，随后被并行新增的 `server/repositories/policy-reviews.js` raw SQL审核门禁阻断：17处直接SQL缺少对应审核记录。该文件不属于本次文档版本同步，未修改其代码或放宽门禁；这与前述功能阶段的PPT体积门禁是两次不同检查记录。
- 本次未重复业务回归或重建Docker/桌面制品；上述功能证据仍绑定原v0.7.143镜像。

## 前期 slim 依赖复查

最终合并打包之前，完整镜像复查还得到以下结果。其镜像身份和源码快照早于最终单镜像，不能把所有批次的数量相加为独立覆盖率：

- 43个直接生产依赖和1197个服务端JS文件中的35种静态第三方导入均可解析。`npm ls`的6项缺失报告对应明确裁剪的类型声明或浏览器专用包；动态拼接导入不在静态解析保证内。
- 排除musl备用二进制以及当前业务不引用的Python Tk/NIS扩展后，91个适用原生二进制未检出缺少共享库。Tk/NIS所需系统库不完整，不能声称任意额外Python脚本都能运行。
- SQLite文件数据库、事务和回滚；DuckDB查询与Parquet往返；Sharp中文SVG、PNG/JPEG转换；项目PDF文本抽取与渲染；qpdf实际页面处理；DOCX、XLSX和ZIP往返均通过。
- Vosk实际加载模型并处理一秒静音，返回正常语言和空文本；语音虚拟环境 `pip check` 通过。Chromium以非root身份完成本地页面、截图与PDF生成；字体完整性检查通过。
- PostgreSQL工具可运行，`pg_verifybackup`位于 `/usr/lib/postgresql/16/bin/`，按独立物理备份文档填写工具目录，不属于未安装。早期临时PostgreSQL18启动测试不证明16.x客户端能备份18.x服务器。
- 修复后的完整镜像曾使用独立内部网络和临时PostgreSQL16完成启动、数据库初始化、登录、鉴权健康详情、会话接口及静态资源验证；镜像内PDF引擎和探测回归7项通过、无跳过。临时数据库关闭同步写用于功能验证，不能当作持久性或性能认证；测试资源已清理。

## 未验证范围与复现入口

未进行全仓 `npm test`、`verify`、生产部署、桌面安装包、ARM64、真实外部模型/OCR/FunASR/PPT服务或生产备份恢复验收。本机GPU验证被NVIDIA预启动检查拒绝，原因为WSL未发现适配器，不能据此判断目标GPU服务器的功能。桌面Electron43源码编译回退尚需目标平台单独验证。

原始构建、JSONL和测试日志保留在本次构建机；本报告固化其镜像身份、命令、结果和限制。可重复执行以下工程入口，结果以实际新运行记录为准：

```sh
node --test tests/dockerfile-runtime-contract.test.js tests/terminal-capability-worker-runner.test.js tests/capability-worker-runner.test.js tests/verapdf-health.test.js
node --test tests/pdf-tools-browser.test.js
docker build -t pivot:latest .
```

镜像启动和工具版本检查见[生产环境离线部署](../生产环境离线部署.md)，新增版本的构建与登记步骤见[发布说明](../releases/v0.7.144-Docker单镜像完整打包与运行依赖修复.md)。
