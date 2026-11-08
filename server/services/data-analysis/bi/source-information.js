'use strict';

const repository = require('../../../repositories/analysis-source-metadata');
const { protect } = require('./delivery');

function protectInformation(result, user, datasetId) { return protect(result, { userId: user.id, definition: { nodes: [{ id: 'source', datasetId }] }, required: new Map() }); }
async function getSourceInformation(user, datasetId) { return protectInformation(await repository.get(user.id, datasetId), user, datasetId); }
async function saveSourceInformation(user, datasetId, body) { return protectInformation(await repository.save(user.id, datasetId, body), user, datasetId); }

module.exports = { getSourceInformation, saveSourceInformation };
