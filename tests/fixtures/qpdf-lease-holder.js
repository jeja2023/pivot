'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { withQpdfLease } = require('../../server/services/document-processing/qpdf-workdir-lease');
withQpdfLease(async directory => {
    await fs.writeFile(path.join(directory, 'input-password.txt'), 'test-only');
    process.send({ directory });
    await new Promise(() => {});
}).catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
