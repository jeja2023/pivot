'use strict';

function escapeCsvCell(value) {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[\s\u0000-\u0020]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

module.exports = { escapeCsvCell };
