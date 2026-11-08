# 第三方组件与许可声明

本发行版可能包含下列第三方组件。完整的 LGPL-3.0-or-later 许可文本随发行包位于同目录的 `LGPL-3.0.txt`。

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| sharp | 图片处理 Node.js 绑定 | Apache-2.0 |
| Ponytail 5.3.3 指引适配 | 中文代码审查、仓库审计与复用原则参考 | MIT |
| libvips（由 sharp 预编译二进制携带） | 图片编解码与变换 | LGPL-3.0-or-later |
| KaTeX | 公式排版 | MIT |
| ECharts | 图表渲染 | Apache-2.0 |
| Apache POI DrawingML 预设形状数据（187 类） | 原生形状的浏览器/服务端几何求值 | Apache-2.0 |
| PPT Master 形状/几何接口参考 | DrawingML 数据来源追溯与公式/圆弧行为参考 | MIT |
| PPT Master 6.8.0 完整技能发行包 | 固定工作流、模板、转换与公式工具 | MIT；包内第三方资源各自许可随原包保留 |
| LibreOffice Impress（Debian发行包） | 离线原稿静态预览 | MPL-2.0 / LGPL及所含组件各自许可，详见镜像内copyright文件 |
| Poppler（Debian poppler-utils） | 本地PDF页面栅格化 | GPL及所含组件各自许可，详见镜像内copyright文件 |
| FFmpeg / libx264（Debian发行包） | 本地页面视频与音频编码 | 构建配置决定的GPL/LGPL及相关许可，详见镜像内copyright文件 |
| Matplotlib 3.11.2 及随包数学字体 | 离线预览副本中的独立公式排版 | Matplotlib许可及字体各自许可，完整声明保留在Python包与dist-info目录 |
| Mermaid 11.17.2（离线静态构建） | 回复中的图形预览 | MIT；所含依赖许可见资源清单 |
| SimpleMindMap 0.14.0-fix.3（裁剪构建） | 思维导图编辑、布局与导出 | MIT |
| Yjs 13.6.33 / lib0 | 思维导图字段级协作合并与本地撤销 | MIT |
| @xmldom/xmldom | OPML/FreeMind 的受控 XML 解析 | MIT |
| veraPDF Greenfield CLI | PDF/A 与 PDF/UA 合规验证 | GPL-3.0-or-later 或 MPL-2.0 |
| Vosk API 与 vosk-model-small-cn-0.22 | Docker 部署内离线中文语音识别 | Apache-2.0 |
| ws | 受控流式语音 WebSocket 代理 | MIT |
| CPython 3.12 | 项目 Python、Agent 与语音工作进程运行时 | Python Software Foundation License Version 2 |
| FunASR | CPU 中文双遍识别与标点模型推理 | MIT |
| PyTorch / torchaudio | CPU 张量推理与音频处理 | BSD-3-Clause |
| Silero VAD | 无语音过滤 | MIT |
| Transformers | FunASR 模型运行依赖 | Apache-2.0 |
| SeACo Paraformer、流式 Paraformer、CT-Transformer 标点模型 | 管理员离线导入的中文识别与标点权重 | Apache-2.0 |

libvips 以动态链接库形式与应用分发；用户可以替换该动态库。项目未修改 libvips 本身。有关源代码和许可信息，请访问组件各自的上游发布页或本发行包内的相关许可文件。

思维导图编辑器基于 [SimpleMindMap](https://github.com/wanglin2/mind-map) 开源库构建，版权归 The MindMap Team 所有。项目只编译所需插件，未引入其闭源桌面产品。完整 MIT 许可见 `SIMPLE-MIND-MAP-MIT.txt`；实际构建依赖、精确版本和摘要见 `client/common/vendor/simple-mind-map/0.14.0-fix.3/provenance.json`，所含组件完整许可保存在同目录 `LICENSES.txt`。运行时不依赖 CDN。

Mermaid 图形预览使用 [Mermaid](https://github.com/mermaid-js/mermaid) 11.17.2，按需加载本地构建；DOMPurify 双许可部分选择 Apache-2.0 分支。D3 的表格对象转换在构建时替换为静态闭包，避免动态函数构造。完整依赖版本、原始许可和构建摘要位于 `client/common/vendor/mermaid/11.17.2/`，主界面不加载该运行时，不依赖公网服务。

Docker 发行镜像中的 veraPDF CLI 来自 veraPDF 官方固定版本安装包，构建时校验 SHA-256 后以 CLI-only 模式安装。veraPDF 仅用于验证，不执行 PDF/A 转换；其完整许可与源代码获取方式见 [veraPDF 官方项目](https://github.com/veraPDF/veraPDF-apps)。

Vosk 运行库由固定版本 Python 依赖安装，其第三方依赖许可随各包的 dist-info 一同保留。中文模型来自 [Vosk 官方模型列表](https://alphacephei.com/vosk/models)，构建时校验 SHA-256；运行时无需联网下载。完整 Apache-2.0 文本随包提供在 `APACHE-2.0.txt`，模型内容未被修改。

主镜像中的 CPython 3.12 来自 [Python 官方 Docker 镜像](https://github.com/docker-library/python)，解释器自带的 `LICENSE.txt` 随标准库目录保留；项目未修改解释器源码。系统软件可能因发行版依赖保留自己的 Python，项目通过 `/usr/local/bin/python3.12` 明确选择运行时。

CPU 语音 Python 包的许可证、作者和版本元数据随虚拟环境中的 `dist-info` 保留。模型权重由管理员单独导入，不打包进主镜像；交付时须连同模型仓库的说明及许可一并保留。

## Ponytail 指引

Ponytail 指引固定参考 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846) 的 5.3.3 版本，提交 `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`。中文适配保存在 `server/skills/code-review/SKILL.md` 和 `server/skills/code-audit/SKILL.md`，采用 Pivot 的只读工具、显式调用与验收边界，不包含原插件的生命周期脚本、模式持久化或统计面板。完整原始 MIT 许可与版权声明见同目录 `PONYTAIL-MIT.txt`，随服务端和桌面发行保留。

## DrawingML 预设形状

原稿/视频执行镜像中的Debian组件通过发行包安装，未删除 `/usr/share/doc/<package>/copyright`，各包版本和对应源代码由Debian相同发行版及安全更新仓库提供。正式离线分发时须随镜像保留版权声明及适用许可，并提供与实际二进制对应的源代码获取或随附方式；不能以PPT Master的MIT许可覆盖LibreOffice、Poppler、FFmpeg或字体的独立许可。

固定来源与转换方式见 `client/vendor/presentation/NOTICE.md`。运行时目录由 Apache POI 5.4.1 的形状数据机械转换，随发行版保留 Apache-2.0 完整文本；PPT Master 的 MIT 声明同时保留。文件位于 `client/vendor/presentation/`，不依赖在线下载。
