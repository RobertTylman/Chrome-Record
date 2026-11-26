// Zips dist/ into release/chrome-recorder-<version>.zip for the Chrome Web Store, with
// manifest.json at the root of the archive. Run with `npm run package` (builds first).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const outDir = path.join(root, 'release');
const out = path.join(outDir, `chrome-recorder-${version}.zip`);

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(out, { force: true });
// -X leaves out extra file attributes; macOS Finder files are never included
execFileSync('zip', ['-r', '-X', out, '.', '-x', '*.DS_Store', '-x', '*.map'], { cwd: dist, stdio: 'inherit' });
console.log(`\nCreated ${path.relative(root, out)}`);
