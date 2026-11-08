# 可选的受控分析协调镜像。只复制客户端，不在应用容器中运行 Docker daemon。
# 固定 Linux/amd64 官方客户端清单；其它架构须另行完成支持矩阵验证。
ARG DOCKER_CLI_IMAGE=docker:29.9.3-cli@sha256:b0d99f37f463c88cae2082083f705210296186c06632d22f6952ed43506ae520
ARG PIVOT_IMAGE=pivot:latest
FROM ${DOCKER_CLI_IMAGE} AS docker-client
FROM ${PIVOT_IMAGE}
USER root
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY docker/analysis-controller/docker-cli-LICENSE.txt /app/licenses/DOCKER-CLI-APACHE-2.0.txt
RUN docker --version
USER node

