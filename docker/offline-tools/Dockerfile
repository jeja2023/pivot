ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
FROM ${PYTHON_IMAGE}
WORKDIR /opt/pivot-tools
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY docker/offline-tools/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY docker/offline-tools/*.py ./
USER 1000:1000
EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8501/health', timeout=3)"
CMD ["python", "app.py"]
