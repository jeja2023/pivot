# 截图公文标准的字体配置

严格公文导出使用用户指定的原字体：

| 用途 | 字体 | 默认文件名 |
| --- | --- | --- |
| 标题 | 方正小标宋_GBK | 方正小标宋_GBK.TTF |
| 正文、主送、落款、附件说明 | 方正仿宋_GBK | 方正仿宋_GBK.TTF |
| 一级层级、附件标识 | 方正黑体_GBK | 方正黑体_GBK.TTF |
| 二级层级 | 方正楷体_GBK | 方正楷体_GBK.TTF |
| 页码 | 宋体 | simsun.ttc |
| 阿拉伯数字和西文 | Times New Roman | times.ttf |

生产镜像内置全部六种字体，总大小为 69,533,296 字节（66.31 MiB）。字体二进制由发布流程提供，不提交到源码仓库；本目录的 `manifest.json` 记录字体用途、内部字体名、文件大小和 SHA-256。发布方负责保管覆盖服务器部署与镜像交付的授权凭证，嵌入标记和摘要校验不替代授权证明。

## 准备与构建生产镜像

在构建机器安装项目依赖后，从受控的已授权字体目录准备构建资产，例如本次核验的 Windows 字体目录：

```powershell
npm run prepare:official-fonts -- C:/Windows/Fonts
npm run check:official-fonts
docker build -t pivot:latest .
```

Linux 构建机器可使用 `npm run prepare:official-fonts -- /srv/pivot-authorized-fonts`。准备命令只读取显式指定的来源，检查六种字体与清单一致后复制到本目录；已有不同版本会报错，不会覆盖。也可把受控字体包的六个文件直接放入本目录后执行校验。清单锁定本次核验版本，更换字体版本时应审核更新清单并重新执行渲染测试。

本次已准备受控归档 `pivot-official-fonts-screenshot-20261104.tar.gz` 和同名 `.sha256` 文件，放在本机构建目录的 `artifacts/release/` 中。发布人员可将二者传入有权使用字体的构建机器，在项目根目录核验并解包；解包前应确认现有字体文件与本次版本一致：

```bash
sha256sum -c pivot-official-fonts-screenshot-20261104.tar.gz.sha256
tar -xzf pivot-official-fonts-screenshot-20261104.tar.gz
npm run check:official-fonts
```

Dockerfile 会把本目录复制到 `/app/assets/fonts/official`，最后的默认 `runtime` 阶段以 `node` 用户检查文件完整性、内部字体名和嵌入权限。缺文件、摘要不符或不允许嵌入都会使生产构建失败。校验只读取镜像内目录，不借用系统字体或 `PIVOT_PDF_FONT_DIR`。

部署完成的生产镜像无需安装字体或挂载字体目录，离线启动即可导出。可执行以下命令检查镜像内资产：

```bash
docker run --rm --network none pivot:latest node scripts/official_fonts.js check
```

源码 CI 在没有授权字体时构建 `runtime-base` 阶段，并验证字体包缺失会被拒绝；该阶段只用于基础依赖验证，不作为完整生产制品发布。正式发布使用默认的最终阶段，不指定 `--target runtime-base`。

## 源码与桌面运行

Windows 服务优先读取 `PIVOT_PDF_FONT_DIR` 和本目录，并可使用 `C:/Windows/Fonts` 中已安装的字体。其他源码服务器可将原字体放入本目录或通过 `PIVOT_PDF_FONT_DIR` 指定目录；该变量同时用于普通 PDF 字体，应保持普通 PDF 的 CJK 字体配置可用。加载器会校验字体内部族名与嵌入标记，不接受仅改文件名的替代字体。缺失或禁止嵌入时，严格公文 DOCX/PDF 导出会明确失败。

DOCX 写入准确的中西文字体名，PDF 嵌入对应字形子集。接收 DOCX 的电脑也应安装相应字体；不同电脑缺字体时 Word 可能自行替代，应用无法把该替代结果标为合规。PDF 已嵌入字形，可用于固定版式流转。

自动化测试使用相同的字体加载校验。未安装上述授权字体时，真实 DOCX/PDF 渲染和版式测试会明确标记为跳过；其他加载异常仍会导致测试失败。缺字体时拒绝导出的回归测试始终执行。需要验证完整渲染结果时，请准备字体包后运行相关测试。

本项改造归入 [v0.7.93 发布记录](../../../docs/releases/v0.7.93-公文字体内置与生产镜像构建校验.md)，生产机操作另见[离线部署说明](../../../docs/生产环境离线部署.md)。
