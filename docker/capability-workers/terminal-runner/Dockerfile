ARG BASE_IMAGE=pivot:latest
FROM ${BASE_IMAGE}

WORKDIR /workspace
COPY docker/capability-workers/terminal-runner/runner.js /runner/runner.js
USER node
ENTRYPOINT []
CMD ["node", "/runner/runner.js"]
