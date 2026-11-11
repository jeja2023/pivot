'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { asyncHandler } = require('../http');
const { applyAppVersionTemplate } = require('../version');

function registerArtifactSharePage(app, version) {
    app.get('/artifacts/shared/:shareId', asyncHandler(async (_req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        const template = await fs.readFile(path.resolve(__dirname, '../../client/artifact-share.html'), 'utf8');
        res.type('html').send(applyAppVersionTemplate(template, version));
    }));
}

module.exports = { registerArtifactSharePage };
