# 在联网准备机构建并验收，再将镜像整体导入内网。
# 基础镜像默认使用 Docker Hub 官方镜像；国内网络构建可通过 --build-arg 覆盖镜像源：
#   --build-arg SPEECH_PYTHON_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/python:3.12-slim-bookworm
ARG SPEECH_PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${SPEECH_PYTHON_IMAGE}
WORKDIR /opt/speech
RUN python -c "import sys; assert sys.version_info[:2] == (3, 12), sys.version"
COPY docker/speech-service/requirements.txt docker/speech-service/requirements-qwen.txt ./
ARG SPEECH_INCLUDE_QWEN=false
COPY artifacts/speech-wheelhouse/ /wheels/
RUN if [ "$SPEECH_INCLUDE_QWEN" = "true" ]; then pip install --no-index --find-links=/wheels -r requirements-qwen.txt; \
    else pip install --no-index --find-links=/wheels -r requirements.txt; fi \
    && pip check && rm -rf /wheels
COPY docker/speech-service/app.py docker/speech-service/engine.py ./
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 MODELSCOPE_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 \
    SPEECH_BACKEND=funasr SPEECH_DEVICE=cpu HOME=/tmp
USER 1000:1000
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--ws-max-size", "65536"]
