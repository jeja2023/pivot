const cleanup = require('./cleanup');
const jobs = require('./jobs');
const ocr = require('./ocr');
const pdf = require('./pdf');
const settings = require('./settings');
const textExtraction = require('./text-extraction');

module.exports = {
    ...cleanup,
    ...jobs,
    ...ocr,
    ...pdf,
    ...settings,
    ...textExtraction
};