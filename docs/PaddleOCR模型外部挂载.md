# PaddleOCR 模型外部挂载

文档处理底座默认通过外部命令调用 OCR 引擎，不把 PaddleOCR 模型文件打进 Pivot 镜像。当前先使用轻量的 PP-OCRv6 作为基础 OCR 能力；PaddleOCR-VL-1.6 后续作为高级文档解析功能单独接入。

本地开发环境直接使用项目内 `models/paddleocr` 目录；Docker 生产部署时再把宿主机同一目录挂载到容器 `/app/models/paddleocr`，和其他持久化目录保持一致。

## Docker 挂载

`docker-compose.yml` 已预置：

```yaml
volumes:
  - ./models/paddleocr:/app/models/paddleocr
```

宿主机目录建议结构：

```text
models/
  paddleocr/
    det/  # PP-OCRv6 文本检测模型，必需
    rec/  # PP-OCRv6 文本识别模型，必需
    cls/  # 文本行方向模型，可选
    fonts/
      simfang.ttf  # 结果可视化字体，避免离线运行时下载
```

由于模型目录统一放在项目内 `models/paddleocr`，建议在 `.env` 中显式配置相对路径 `PADDLEOCR_*_MODEL_DIR`，不要依赖 PaddleOCR 默认缓存目录。

## 环境变量

`.env.example` 已提供默认配置：

```env
DOCUMENT_PROCESSING_OCR_ENGINE=paddle
PADDLEOCR_CMD=paddleocr
PADDLEOCR_DOCKER_CMD=paddleocr
PADDLEOCR_LANG=ch
PADDLEOCR_CLI_VERSION=3
PADDLE_PDX_CACHE_HOME=data/paddlex-cache
PADDLE_PDX_LOCAL_FONT_FILE_PATH=models/paddleocr/fonts/simfang.ttf
```

如果已经预置了检测、识别、方向分类模型，可以在 `.env` 中指定容器内路径：

```env
PADDLEOCR_DET_MODEL_DIR=models/paddleocr/det
PADDLEOCR_REC_MODEL_DIR=models/paddleocr/rec
PADDLEOCR_CLS_MODEL_DIR=models/paddleocr/cls
```

`PADDLEOCR_CLI_VERSION=3` 表示使用 PaddleOCR 3.x / PP-OCRv6 参数：

```bash
paddleocr ocr -i input.png \
  --text_detection_model_dir models/paddleocr/det \
  --text_recognition_model_dir models/paddleocr/rec
```

配置 `PADDLEOCR_CLS_MODEL_DIR` 时，服务会自动追加文本行方向相关参数。旧版 PaddleOCR CLI 如需继续使用 `--det_model_dir`、`--rec_model_dir`、`--cls_model_dir`，可设置：

```env
PADDLEOCR_CLI_VERSION=legacy
```

也可以继续用 `PADDLEOCR_ARGS` 传递 PaddleOCR CLI 额外参数。


## 本地开发运行时

本地开发环境可使用项目内虚拟环境，不需要 Docker 挂载：

```powershell
python -m venv .venv-paddleocr
.\.venv-paddleocr\Scripts\python.exe -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
.\.venv-paddleocr\Scripts\python.exe -m pip install --upgrade paddleocr
```

本地 `.env` 可把命令指向项目内 venv：

```env
PADDLEOCR_CMD=.venv-paddleocr/Scripts/paddleocr.exe
PADDLEOCR_DOCKER_CMD=paddleocr
```

`PADDLEOCR_CMD` 只用于本机直接启动服务；Docker 生产部署会用 `PADDLEOCR_DOCKER_CMD` 覆盖容器内命令，避免 Windows 路径进入 Linux 容器。

## 关于 paddleocr 命令

默认 Dockerfile 会在构建阶段安装 PaddleOCR/PaddlePaddle 运行时，并把 `paddleocr` 命令放进镜像 PATH；模型文件仍通过 `models/paddleocr` 外部挂载。启用容器内 OCR 时需要满足其一：

1. 使用默认 `PIVOT_INSTALL_PADDLEOCR=true` 重新构建镜像。
2. 设置 `PIVOT_INSTALL_PADDLEOCR=false`，但将 Linux 版可执行命令或虚拟环境挂载进容器，并把 `PADDLEOCR_DOCKER_CMD` 指向对应的容器内路径。
3. 暂时改用已安装的其他 OCR 命令，并设置 `DOCUMENT_PROCESSING_OCR_ENGINE`。

验证方式：

```bash
docker exec pivot paddleocr --help
docker exec pivot node -e "require('./server/services/document-processing').getOcrEngineStatus().then(console.log)"
```