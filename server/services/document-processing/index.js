const cleanup = require('./cleanup');
const jobs = require('./jobs');
const ocr = require('./ocr');
const pdf = require('./pdf');
const settings = require('./settings');
const secrets = require('./secrets');
const textExtraction = require('./text-extraction');
const reviewAssignments = require('./review-assignments');
const regions = require('./regions');
const feedback = require('./feedback');
const chatContext = require('./chat-context');

module.exports = {
    ...cleanup,
    ...jobs,
    ...ocr,
    ...pdf,
    ...settings,
    ...secrets,
    ...textExtraction,
    ...reviewAssignments,
    ...regions,
    ...feedback,
    ...chatContext
};
