const { OUTPUT_TYPES } = require('./constants');
const { createTextOutputs } = require('./exporters');
const { createSearchablePdfOutput } = require('./pdf');
const { getDocumentFileForUser } = require('./files');

function createDocumentExportActions({ getJobRow, getPages, getBlocks }) {
    async function createJobExport({ userId, jobId, format = OUTPUT_TYPES.TEXT }) {
        const job = await getJobRow(jobId, userId);
        if (!job) return null;
        const file = await getDocumentFileForUser(job.file_id, userId);
        const pages = await getPages(job.id);
        const blocks = await getBlocks(job.id);
        const normalizedFormat = Object.values(OUTPUT_TYPES).includes(format) ? format : OUTPUT_TYPES.TEXT;
        if (normalizedFormat === OUTPUT_TYPES.SEARCHABLE_PDF) {
            return createSearchablePdfOutput({ userId, file, job, pages, blocks });
        }
        const outputs = await createTextOutputs({ userId, file, job, pages, blocks, formats: [normalizedFormat] });
        return outputs[0] || null;
    }

    return { createJobExport };
}

module.exports = { createDocumentExportActions };
