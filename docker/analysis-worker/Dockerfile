# 复用已经完成依赖安装与离线校验的 Pivot 基础制品；构建阶段不联网安装软件。
ARG PIVOT_IMAGE=pivot:latest
FROM ${PIVOT_IMAGE}
WORKDIR /app
COPY server/services/data-analysis/bi/ /app/server/services/data-analysis/bi/
COPY server/services/canonical-json.js /app/server/services/canonical-json.js
COPY server/services/data-analysis/profile-sql.js server/services/data-analysis/numeric-values.js /app/server/services/data-analysis/
COPY server/csv.js /app/server/csv.js
COPY server/workers/analysis-model-worker.js /app/server/workers/analysis-model-worker.js
HEALTHCHECK NONE
USER 65532:65532
ENTRYPOINT ["node", "/app/server/workers/analysis-model-worker.js"]
