# OCR 服务对接协议

Pivot 不内置 OCR 引擎，也不维护 OCR 镜像、模型、缓存和具体识别运行时。OCR 由独立项目部署，Pivot 只通过 HTTP 调用该服务。

## 一、Pivot 侧配置

根目录 `.env` 保留以下客户端配置：

```env
DOCUMENT_PROCESSING_OCR_ENGINE=http
OCR_SERVICE_URL=http://ocr-service:9100
OCR_SERVICE_HEALTH_TIMEOUT_MS=3000
OCR_SERVICE_MAX_IMAGE_BYTES=52428800
DOCUMENT_PROCESSING_OCR_TIMEOUT_MS=120000
```

`OCR_SERVICE_URL` 可以是 Docker 网络内服务名，也可以是内网 HTTP 地址，例如：

```env
OCR_SERVICE_URL=http://ocr-service:9100
OCR_SERVICE_URL=http://10.0.0.25:9100
```

Pivot 的根目录 `docker-compose.yml` 只启动主应用，不包含 OCR 服务定义，也不再额外注入 `OCR_SERVICE_URL`。管理员也可以在 Pivot 前端“应用中心 > 文字识别”的服务地址中保存更新，保存后的数据库配置优先于 `.env` 默认值；清空并保存服务地址可恢复使用 `.env` 默认值。`DOCUMENT_PROCESSING_OCR_TIMEOUT_MS` 控制单页识别请求超时，`OCR_SERVICE_HEALTH_TIMEOUT_MS` 只控制健康检查，`OCR_SERVICE_MAX_IMAGE_BYTES` 控制单页图片发送给外部服务前的字节上限。

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