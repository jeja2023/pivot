'use strict';

function invalid(message, status = 400, code = 'AGENT_RELEASE_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

module.exports = { invalid };

