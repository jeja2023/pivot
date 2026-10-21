"""用授权的现场语料评测中文字符、关键字、噪声误触发与延迟，不输出转写正文。"""
import argparse
import base64
import ipaddress
import json
import math
import os
from pathlib import Path
import socket
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


def normalized(text):
    return "".join(ch.lower() for ch in unicodedata.normalize("NFKC", text) if not unicodedata.category(ch).startswith(("P", "Z")) and not ch.isspace())


def edit_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, first in enumerate(left, 1):
        current = [i]
        for j, second in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (first != second)))
        previous = current
    return previous[-1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("评测不允许重定向")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path, help="JSONL：id、path、reference、category、keywords[]")
    parser.add_argument("--endpoint", required=True, help="内网网关完整 /transcribe 地址")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    target = urllib.parse.urlparse(args.endpoint)
    addresses = {item[4][0] for item in socket.getaddrinfo(target.hostname, target.port or 80)}
    if target.scheme not in ("http", "https") or target.username or target.password or not addresses:
        raise ValueError("评测服务地址无效")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_private or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            raise ValueError("现场语音评测仅允许内网目标")
    key = os.environ.get("SPEECH_EVAL_API_KEY", "")
    if not key:
        raise ValueError("请设置 SPEECH_EVAL_API_KEY")
    root = args.manifest.resolve().parent
    records = [json.loads(line) for line in args.manifest.read_text("utf-8").splitlines() if line.strip()]
    results = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for record in records:
        file = (root / record["path"]).resolve()
        if not file.is_relative_to(root) or file.stat().st_size > 640044:
            raise ValueError("语料路径或大小无效")
        payload = {"audioBase64": base64.b64encode(file.read_bytes()).decode(), "language": "zh-CN", "hotwords": record.get("hotwords", [])}
        started = time.monotonic()
        request = urllib.request.Request(args.endpoint, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        with opener.open(request, timeout=60) as response:
            body = response.read(65537)
            if len(body) > 65536:
                raise ValueError("识别结果超出上限")
            output = json.loads(body)
        reference = normalized(record.get("reference", ""))
        text = normalized(output.get("text", ""))
        words = [normalized(word) for word in record.get("keywords", [])]
        results.append({"id": record["id"], "category": record["category"], "latencyMs": round((time.monotonic() - started) * 1000),
                        "referenceChars": len(reference), "charErrors": edit_distance(reference, text),
                        "keywords": len(words), "keywordHits": sum(word in text for word in words),
                        "noiseFalsePositive": not reference and bool(text), "requiresReview": output.get("requiresReview") is True})
        payload = None
    summary = {}
    for category in sorted({item["category"] for item in results}):
        group = [item for item in results if item["category"] == category]
        chars = sum(item["referenceChars"] for item in group)
        keywords = sum(item["keywords"] for item in group)
        times = sorted(item["latencyMs"] for item in group)
        summary[category] = {"samples": len(group), "cer": sum(item["charErrors"] for item in group) / chars if chars else None,
                             "keywordAccuracy": sum(item["keywordHits"] for item in group) / keywords if keywords else None,
                             "noiseFalsePositives": sum(item["noiseFalsePositive"] for item in group), "latencyP95Ms": times[max(0, math.ceil(len(times) * 0.95) - 1)]}
    args.output.write_text(json.dumps({"categories": summary, "results": results}, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"语音评测完成，共 {len(results)} 条；报告仅包含数值指标，不保存识别正文")


if __name__ == "__main__":
    main()
