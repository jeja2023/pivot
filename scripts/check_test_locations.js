'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function findTests(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const name = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return findTests(name);
        return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [name] : [];
    });
}

const outside = ['server', 'client', 'desktop'].flatMap(findTests);
if (outside.length) {
    console.error(`测试文件应放入 tests/ 以便执行：\n${outside.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log('测试位置检查通过：业务源码目录没有未执行的测试文件。');
}
