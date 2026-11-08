'use strict';

function biError(code, message, status = 400) {
    return Object.assign(new Error(message), { code, status });
}

module.exports = { biError };
