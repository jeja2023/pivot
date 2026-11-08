# Local Linux durability/PITR verification only. The production deployment
# still uses its independently operated PostgreSQL and backup identities.
ARG PIVOT_IMAGE=pivot:latest
FROM ${PIVOT_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-18 postgresql-18-pgvector \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node server /app/server
COPY --chown=node:node package.json package-lock.json /app/
COPY --chown=node:node scripts/test_support /app/scripts/test_support
COPY --chown=node:node scripts/setup_pg_test_db.js scripts/bi_physical_backup.js /app/scripts/
COPY --chown=node:node tests/bi-modeling-backup-files.test.js tests/bi-modeling-physical-restore.test.js /app/tests/
ENV PATH=/usr/lib/postgresql/18/bin:${PATH}
HEALTHCHECK NONE
USER node
ENTRYPOINT ["node", "--test", "--test-reporter=spec", "/app/tests/bi-modeling-backup-files.test.js", "/app/tests/bi-modeling-physical-restore.test.js"]
