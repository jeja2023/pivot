ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
FROM ${PYTHON_IMAGE}
WORKDIR /opt/pivot-tts
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp HF_HUB_OFFLINE=1 TMPDIR=/runtime
COPY docker/tts-service/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY docker/tts-service/app.py ./app.py
USER 1000:1000
EXPOSE 8502
CMD ["python", "app.py"]
