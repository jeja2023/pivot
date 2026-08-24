const fs = require('fs');
const path = require('path');
const {
    assertLinuxPackageMetadata,
    resolveBuildTarget
} = require('./desktop-build-support');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assertLinuxPackageMetadata(pkg, root);

const supported = [
    resolveBuildTarget(['deb', '--x64']),
    resolveBuildTarget(['deb', '--arm64']),
    resolveBuildTarget(['AppImage', '--x64']),
    resolveBuildTarget(['AppImage', '--arm64'])
];

console.log(JSON.stringify({
    ok: true,
    electron: pkg.devDependencies?.electron,
    supported,
    loong64: 'blocked-until-custom-runtime-is-available'
}, null, 2));
