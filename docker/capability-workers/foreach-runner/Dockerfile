ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

WORKDIR /runner
COPY server/services/agent-foreach-worker.js /runner/agent-foreach-worker.js
USER node
ENTRYPOINT []
CMD ["node", "/runner/agent-foreach-worker.js"]
