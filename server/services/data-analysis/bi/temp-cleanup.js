'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { tempRoot } = require('../shared');
const repository = require('../../../repositories/analysis-integrity');

const protectedTempRoots = new Set(['model-jobs', 'model-readiness', 'ingestion-chunks']);

async function cleanupModelTemporaryFiles({ retentionMs = 86400000, now = Date.now() } = {}) {
    let removed = 0;
    for (const name of protectedTempRoots) {
        const root = path.resolve(tempRoot, name);
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const target = path.resolve(root, entry.name);
            if (path.dirname(target) !== root || path.dirname(root) !== path.resolve(tempRoot)) continue;
            const stat = await fs.lstat(target);
            if (stat.isSymbolicLink() || now - stat.mtimeMs < retentionMs) continue;
            if (name === 'model-jobs') {
                const match = entry.name.match(/^(query_job_[A-Za-z0-9-]+)-\d+$/);
                if (!match || await repository.tempJobProtected(match[1])) continue;
            }
            const realRoot = await fs.realpath(root), realTarget = await fs.realpath(target);
            if (path.dirname(realTarget) !== realRoot) continue;
            await fs.rm(target, { recursive: stat.isDirectory(), force: true }); removed++;
        }
    }
    return { removed };
}

module.exports = { protectedTempRoots, cleanupModelTemporaryFiles };
