# 独立 OCR 项目搭建指南

本文档用于创建一个完全独立于 Pivot 主项目的 OCR 服务项目。Pivot 不关心 OCR 服务内部使用 PaddleOCR、PaddleOCR-VL、Tesseract、商业 OCR API 或其它模型，只通过 HTTP 协议调用外部服务。

## 一、结论

可以在独立 OCR 项目中使用 PaddleOCR-VL，但不要把 PaddleOCR-VL 直接放回 Pivot 主项目或 Pivot 主镜像中。

推荐策略：

- 普通图片/PDF 文字识别：优先使用 PP-OCRv6 或 PP-OCR 系列，速度快、资源占用更可控，适合批量 OCR。
- 复杂版面文档解析：可以使用 PaddleOCR-VL，例如表格、公式、图表、印章、古籍、复杂扫描件等。
- Pivot 对接方式保持不变：独立 OCR 项目最终只需要提供 `GET /health` 和 `POST /ocr`。

## 二、项目目录建议

建议独立项目和 Pivot 同级，例如：

```text
E:/
  pivot/
  ocr-service/
```

`ocr-service` 推荐结构：

```text
ocr-service/
  Dockerfile
  docker-compose.yml
  requirements.txt
  server.py
  .env.example
  README.md
  models/
  data/
```

如果使用 PaddleOCR-VL，模型文件、缓存目录和运行时依赖都放在 `ocr-service` 项目里，不进入 Pivot。

## 三、Pivot 调用协议

Pivot 已按外部 HTTP OCR 服务对接。独立 OCR 项目必须提供：

```http
GET /health
POST /ocr
```

健康检查响应示例：

```json
{
  "status": "ok",
  "engine": "paddleocr-vl"
}
```

识别请求：

```json
{
  "imageBase64": "...",
  "fileName": "page-0001.png",
  "language": "ch",
  "timeoutMs": 120000
}
```

识别响应推荐格式：

```json
{
  "language": "ch",
  "text": "完整识别文本",
  "confidence": 0.92,
  "blocks": [
    {
      "text": "第一行文本",
      "confidence": 0.95,
      "bbox": [],
      "sortOrder": 0
    }
  ],
  "raw": {
    "markdown": "# 可选：PaddleOCR-VL 解析出的 Markdown",
    "json": {}
  }
}
```

Pivot 优先使用 `blocks`；如果没有 `blocks`，会使用 `text` 按换行拆分。

## 四、PaddleOCR-VL 能不能直接用？

可以在独立 OCR 项目里直接使用 PaddleOCR-VL，但需要注意三点：

1. Pivot 不直接调用 PaddleOCR-VL，只调用你的 OCR HTTP 服务。
2. PaddleOCR-VL 更偏“文档解析/版面理解”，返回结果可能是 Markdown、JSON 或结构化页面元素；你需要在 OCR 服务里把结果转换成 Pivot 需要的 `text` / `blocks`。
3. 如果 Pivot 需要坐标框叠加，PaddleOCR-VL 路线可能不如传统 OCR 管线稳定，因为 PaddleOCR 官方也区分了 PaddleOCR-VL 与 PP-StructureV3 的输出特点；需要坐标细节时，应在 OCR 服务内补充坐标归一化逻辑。

建议做成双模式：

```env
OCR_ENGINE=ppocr
# 或
OCR_ENGINE=paddleocr-vl
```

- `ppocr`：用于默认批量 OCR，返回文本块和置信度。
- `paddleocr-vl`：用于复杂文档解析，返回文本、Markdown、结构化 JSON。

## 五、Docker Compose 示例

```yaml
services:
  ocr-service:
    image: ocr-service:latest
    build:
      context: .
      dockerfile: Dockerfile
    container_name: ocr-service
    env_file:
      - .env
    ports:
      - "9100:9100"
    volumes:
      - ./models:/app/models
      - ./data:/app/data
    networks:
      - ai-bridge
    restart: always

networks:
  ai-bridge:
    external: true
```

启动前创建共享网络：

```bash
docker network create ai-bridge || true
```

启动 OCR 项目：

```bash
cd ocr-service
docker compose up -d --build
```

Pivot `.env`：

```env
DOCUMENT_PROCESSING_OCR_ENGINE=http
OCR_SERVICE_URL=http://ocr-service:9100
OCR_SERVICE_HEALTH_TIMEOUT_MS=3000
OCR_SERVICE_MAX_IMAGE_BYTES=52428800
DOCUMENT_PROCESSING_OCR_TIMEOUT_MS=120000
```

## 六、Dockerfile 设计建议

不要把下面这些放到 Pivot 主项目：

- PaddleOCR / PaddlePaddle / PaddleOCR-VL 依赖
- 模型权重
- 字体文件
- GPU/CUDA/OCR 运行时
- OCR 缓存目录

这些都应只存在于 `ocr-service` 项目。

Dockerfile 按实际引擎拆两类更清楚：

```text
Dockerfile.ppocr
Dockerfile.vl
```

或者通过构建参数选择：

```bash
docker build --build-arg OCR_ENGINE=paddleocr-vl -t ocr-service:vl .
docker build --build-arg OCR_ENGINE=ppocr -t ocr-service:ppocr .
```

## 七、服务实现建议

`server.py` 只需要做四件事：

1. 接收 Pivot 传来的 `imageBase64`。
2. 写入临时图片文件。
3. 调用 OCR 引擎识别。
4. 把识别结果转换为 Pivot 协议格式。

伪代码：

```python
@app.get('/health')
def health():
    return {'status': 'ok', 'engine': OCR_ENGINE}

@app.post('/ocr')
def ocr(payload):
    image_path = save_base64_image(payload.imageBase64)
    if OCR_ENGINE == 'paddleocr-vl':
        result = run_paddleocr_vl(image_path)
        return normalize_vl_result(result)
    result = run_ppocr(image_path)
    return normalize_ppocr_result(result)
```

## 八、什么时候选 PaddleOCR-VL？

适合：

- 扫描版报告、合同、制度、表格密集文档。
- 需要 Markdown/JSON 结构化输出。
- 图片里包含公式、图表、印章、复杂版式。
- OCR 服务有较充足 CPU/GPU 资源。

不一定适合：

- 大批量普通文字识别。
- 只需要按行提取纯文本。
- 需要非常稳定的行级坐标框。
- CPU-only 且并发较高的生产环境。

此时更建议默认走 PP-OCR，复杂文档再走 PaddleOCR-VL。

## 九、验收清单

独立 OCR 项目完成后，至少验证：

```bash
curl http://127.0.0.1:9100/health
```

在 Pivot 容器内验证：

```bash
docker exec pivot node -e "require('./server/services/document-processing').getOcrEngineStatus().then(console.log)"
```

要求：

- `http.available` 为 `true`。
- Pivot 上传图片/PDF 后能创建 OCR 任务。
- OCR 任务输出 `text`。
- 复杂文档如使用 PaddleOCR-VL，`raw.markdown` 或 `raw.json` 可用于后续扩展。

## 十、边界

Pivot 主项目只维护调用协议，不维护 OCR 服务内部实现。

后续如果 OCR 项目升级 PaddleOCR-VL、切换 PP-OCR、接入商业 OCR 或增加 GPU 镜像，只要 HTTP 协议不变，Pivot 不需要重新构建。