ARG BASE_IMAGE=pivot:latest
FROM ${BASE_IMAGE}

WORKDIR /runner
COPY docker/capability-workers/code-runner/runner.js /runner/runner.js
USER node
ENTRYPOINT []
CMD ["node", "/runner/runner.js"]
