'use strict';
// npm run zip  ->  lambda.zip (Lab 7).
// Copies only the code Lambda needs into .build/, installs the production libraries there,
// and zips it. .env, tests and dev tools are never included, so no secret can end up in the zip.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

const root = path.join(__dirname, '..');
const build = path.join(root, '.build');
const out = path.join(root, 'lambda.zip');
const INCLUDE = ['app.js', 'lambda.js', 'package.json', 'package-lock.json', 'routes', 'controllers', 'services', 'lib'];

fs.rmSync(build, { recursive: true, force: true });
fs.rmSync(out, { force: true });
fs.mkdirSync(build, { recursive: true });
for (const name of INCLUDE) {
  const src = path.join(root, name);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(build, name), { recursive: true });
}
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: build, stdio: 'inherit' });

const output = fs.createWriteStream(out);
const zip = archiver('zip', { zlib: { level: 9 } });
output.on('close', () => {
  fs.rmSync(build, { recursive: true, force: true });
  console.log(`lambda.zip created (${(zip.pointer() / 1024 / 1024).toFixed(1)} MB)`);
});
zip.on('error', (err) => { throw err; });
zip.pipe(output);
zip.directory(build, false);
zip.finalize();
