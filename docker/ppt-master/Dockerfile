ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
FROM ${PYTHON_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-noto-cjk fonts-dejavu-core ffmpeg libreoffice-impress poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY docker/ppt-master/requirements.lock /runner/requirements.lock
RUN pip install --no-cache-dir --disable-pip-version-check -r /runner/requirements.lock
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-math \
    && rm -rf /var/lib/apt/lists/*
COPY docker/ppt-master/preview-requirements.lock /runner/preview-requirements.lock
RUN pip install --no-cache-dir --disable-pip-version-check -r /runner/preview-requirements.lock
COPY --chmod=0555 artifacts/ppt-master-runtime/ /engine/
COPY config/ppt-master-engine.json /runner/engine-lock.json
COPY --chmod=0555 docker/ppt-master/runner.py docker/ppt-master/tool_catalog.py docker/ppt-master/template_adapter.py /runner/
COPY --chmod=0555 docker/ppt-master/native_*.py /runner/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1 HOME=/tmp OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 SAL_USE_VCLPLUGIN=svp
RUN python /engine/skill/scripts/attribution_guard.py \
    && python -c "import pptx, yaml, xlsxwriter, pathops, uharfbuzz, PIL; import importlib.util; assert importlib.util.find_spec('fitz') is None" \
    && PIVOT_MASTER_WORKSPACE=/tmp python -c "import sys; sys.path.insert(0,'/runner'); from runner import main; assert main({'action':'health'})['status']=='ready'"
USER 65532:65532
WORKDIR /workspace
CMD ["python", "/runner/runner.py"]
