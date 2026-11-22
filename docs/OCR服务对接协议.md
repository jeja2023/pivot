# OCR 服务对接协议

Pivot 不内置 OCR 引擎，也不维护 OCR 镜像、模型、缓存和具体识别运行时。OCR 由独立项目部署，Pivot 只通过 HTTP 调用该服务。

## 一、Pivot 侧配置

根目录 `.env` 保留以下客户端配置：

```env
DOCUMENT_PROCESSING_OCR_ENGINE=http
OCR_SERVICE_URL=http://ocr-service:9100
OCR_VL_SERVICE_URL=
OCR_SERVICE_HEALTH_TIMEOUT_MS=3000
OCR_SERVICE_MAX_IMAGE_BYTES=52428800
DOCUMENT_PROCESSING_OCR_TIMEOUT_MS=120000
```

`OCR_SERVICE_URL` 可以是 Docker 网络内服务名，也可以是内网 HTTP 地址，例如：

```env
OCR_SERVICE_URL=http://ocr-service:9100
OCR_SERVICE_URL=http://10.0.0.25:9100
```

Pivot 的根目录 `docker-compose.yml` 编排主应用，OCR 服务由独立项目运行。最高管理员在「系统设置 → 应用服务 → 文字识别 OCR → 配置」分别保存普通 OCR 和 VL 地址。数据库保存的配置优先，清空对应地址并保存可恢复使用 `.env` 默认值。`DOCUMENT_PROCESSING_OCR_TIMEOUT_MS` 控制单页识别请求超时，`OCR_SERVICE_HEALTH_TIMEOUT_MS` 控制健康检查，`OCR_SERVICE_MAX_IMAGE_BYTES` 控制单页图片发送给外部服务前的字节上限。

保存地址时校验配置并写入数据库，服务是否可达通过「测试连接」和「测试 VL 连接」分别验证。Pivot 直接在本机 Node 中运行时，填写该机器可解析和访问的服务地址。如果 OCR 运行在另一台机器的容器里，可填写 OCR 宿主机的内网地址和各自映射的端口。

## 二、健康检查接口

外部 OCR 服务需要提供：

```http
GET /health
```

成功响应示例：

```json
{
  "status": "ok",
  "engine": "external-ocr"
}
```

Pivot 只要求 HTTP 状态码为 2xx。`status`、`engine` 用于页面展示和排查。

## 二点一、能力接口（推荐）

外部服务可额外提供：

```http
GET /capabilities
```

该接口应返回固定模型版本、支持语言、文字坐标、表格、公式、区域识别与输入限制。未声明的能力必须按“不支持”处理，不能把普通文字识别误认为结构化表格或公式已经可靠解析。

## 文档解析（VL）

最高管理员可在「系统设置 → 应用服务 → OCR」单独填写并测试 VL 地址。也可在部署环境设置 `OCR_VL_SERVICE_URL=http://ocr-service-vl:9100`。数据库保存的地址优先，留空且环境变量未配置时，工作台禁用 VL 模式。普通识别仍使用 `OCR_SERVICE_URL`。两个服务可部署在不同主机，Pivot 只需要访问对应地址。

VL 服务的 `GET /health` 应返回 `engine: "paddleocr-vl"`，并可用 `ready: false` 标识模型文件未就绪。VL 任务按页调用 `POST /ocr`，请求增加 `engine: "paddleocr-vl"`，响应保留普通 OCR 的文本和文字块，并在 `raw.engine` 返回 `paddleocr-vl`、在 `raw.markdown` 返回本页 Markdown 字符串。空白页可以返回空字符串。单页 Markdown 入库上限为 128 KiB。Pivot 使用受限的排版 HTML 标签，不在预览中加载模型输出里的外部资源。

任务选用 `ocrMode: "document_vl"` 后，预检和上传沿用图片/PDF 的页数限制。失败页重试使用保存在任务中的模式。Markdown 导出按原页码组织，保留解析失败提示，有人工文字修订的页面导出修订后的文本。复杂版式的原始外观以页面预览为准。

## 三、识别接口

外部 OCR 服务需要提供：

```http
POST /ocr
Content-Type: application/json
```

Pivot 请求体：

```json
{
  "imageBase64": "...",
  "fileName": "page-0001.png",
  "language": "ch",
  "timeoutMs": 120000
}
```

字段说明：

- `imageBase64`：页面图片或图片文件内容，Base64 编码。
- `fileName`：原始文件名，仅用于日志或临时文件后缀判断。
- `language`：用户选择的语言，例如 `ch`、`en`、`mixed`。
- `timeoutMs`：本次识别期望超时时间，单位毫秒。

## 四、识别响应

推荐响应结构：

```json
{
  "language": "ch",
  "text": "完整识别文本",
  "confidence": 0.92,
  "model": { "id": "pp-ocr", "version": "固定模型版本或权重哈希" },
  "quality": { "score": 0.88, "reasons": ["blur"] },
  "blocks": [
    {
      "text": "第一行文本",
      "confidence": 0.95,
      "bbox": [[10, 10], [200, 10], [200, 40], [10, 40]],
      "sortOrder": 0
    }
  ]
}
```

`blocks` 优先级高于 `text`。如果只返回 `text`，Pivot 会按换行拆成文本块。`bbox` 可为空数组，`confidence` 可省略。

`confidence` 省略时，Pivot 保留为“未知”，不会伪造默认分数。文字块按 `sortOrder` 稳定排序。可选 `tables` 使用 `rowCount`、`columnCount` 和 `cells`；每个单元格包含 `rowIndex`、`columnIndex`、`rowSpan`、`columnSpan`、`text`、可选 `confidence` 与 `bbox`。复杂表格、公式、手写和区域识别只有在服务能力契约及组织样本验证通过后才向用户启用。

## 五、错误响应

外部 OCR 服务发生错误时建议返回非 2xx 状态码，并提供简短错误信息：

```json
{
  "error": "model files not found"
}
```

也可以使用 FastAPI 风格：

```json
{
  "detail": "model files not found"
}
```

Pivot 会把错误归一成“外部 OCR 服务识别失败”，并提示检查 `OCR_SERVICE_URL` 和服务状态。

## 六、部署约定

如果主应用和 OCR 服务都在 Docker 中，建议加入同一个外部网络：

```bash
docker network create ai-bridge || true
```

OCR 项目建议把服务命名为 `ocr-service`，这样 Pivot 默认 `OCR_SERVICE_URL=http://ocr-service:9100` 可直接使用；也可以改成任意服务名或内网地址。
