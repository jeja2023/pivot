'use strict';

// 该脚本仅用于手工/CI 的 Docker 强隔离探针：网络被正确禁用时，连接错误是成功结果。
const http = require('http');

const timeout = setTimeout(() => {
    process.stderr.write('NETWORK_UNEXPECTEDLY_REACHABLE_OR_HUNG\n');
    process.exit(2);
}, 1500);

const request = http.get('http://1.1.1.1/', response => {
    response.resume();
    clearTimeout(timeout);
    process.stderr.write('NETWORK_UNEXPECTEDLY_REACHABLE\n');
    process.exit(2);
});
request.on('error', () => {
    clearTimeout(timeout);
    process.stdout.write('NETWORK_BLOCKED\n');
    process.exit(0);
});
