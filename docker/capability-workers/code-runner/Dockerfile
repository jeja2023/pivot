ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

WORKDIR /runner
COPY docker/capability-workers/code-runner/runner.js /runner/runner.js
USER node
ENTRYPOINT []
CMD ["node", "/runner/runner.js"]
