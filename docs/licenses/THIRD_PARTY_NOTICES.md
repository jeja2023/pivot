# 第三方组件与许可声明

本发行版可能包含下列第三方组件。完整的 LGPL-3.0-or-later 许可文本随发行包位于同目录的 `LGPL-3.0.txt`。

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| sharp | 图片处理 Node.js 绑定 | Apache-2.0 |
| libvips（由 sharp 预编译二进制携带） | 图片编解码与变换 | LGPL-3.0-or-later |
| KaTeX | 公式排版 | MIT |
| ECharts | 图表渲染 | Apache-2.0 |
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

Docker 发行镜像中的 veraPDF CLI 来自 veraPDF 官方固定版本安装包，构建时校验 SHA-256 后以 CLI-only 模式安装。veraPDF 仅用于验证，不执行 PDF/A 转换；其完整许可与源代码获取方式见 [veraPDF 官方项目](https://github.com/veraPDF/veraPDF-apps)。

Vosk 运行库由固定版本 Python 依赖安装，其第三方依赖许可随各包的 dist-info 一同保留。中文模型来自 [Vosk 官方模型列表](https://alphacephei.com/vosk/models)，构建时校验 SHA-256；运行时无需联网下载。完整 Apache-2.0 文本随包提供在 `APACHE-2.0.txt`，模型内容未被修改。

主镜像中的 CPython 3.12 来自 [Python 官方 Docker 镜像](https://github.com/docker-library/python)，解释器自带的 `LICENSE.txt` 随标准库目录保留；项目未修改解释器源码。系统软件可能因发行版依赖保留自己的 Python，项目通过 `/usr/local/bin/python3.12` 明确选择运行时。

CPU 语音 Python 包的许可证、作者和版本元数据随虚拟环境中的 `dist-info` 保留。模型权重由管理员单独导入，不打包进主镜像；交付时须连同模型仓库的说明及许可一并保留。
