const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BEIJING_TIMESTAMP_FORMATTER, formatBeijingLogTimestamp } = require('../server/logger');

const loggerSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'logger.js'), 'utf8');

test('控制台日志按东八区显示且不附带时区后缀', () => {
    assert.ok(BEIJING_TIMESTAMP_FORMATTER instanceof Intl.DateTimeFormat);
    assert.match(loggerSource, /const BEIJING_TIMESTAMP_FORMATTER = new Intl\.DateTimeFormat/);
    assert.equal((loggerSource.match(/new Intl\.DateTimeFormat/g) || []).length, 1);
    assert.match(loggerSource, /translateTime:\s*'SYS:yyyy-mm-dd HH:MM:ss\.l'/);
    assert.doesNotMatch(loggerSource, /translateTime:\s*'yyyy-mm-dd HH:MM:ss'/);
    assert.equal(
        formatBeijingLogTimestamp(new Date('2026-09-08T12:47:31.199Z')),
        '2026-09-08T20:47:31.199+08:00'
    );
});
