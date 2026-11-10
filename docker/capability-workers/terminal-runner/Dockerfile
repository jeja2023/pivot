ARG BASE_IMAGE=pivot:latest
FROM ${BASE_IMAGE}

WORKDIR /workspace
USER node
RUN node --version && python3 --version && git --version && rg --version && node --check /runner/runner.js
ENTRYPOINT []
CMD ["node", "/runner/runner.js"]
