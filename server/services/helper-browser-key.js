'use strict';
const crypto = require('node:crypto');
function helperBrowserKey(req, user) {
    const cookie = String(req.headers?.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('pivot_device_id='));
    const value = cookie?.slice('pivot_device_id='.length) || '';
    return user?.id && /^[A-Za-z0-9_-]{24,128}$/.test(value) ? crypto.createHash('sha256').update(`${user.id}:${value}`).digest('hex') : '';
}
module.exports = { helperBrowserKey };
