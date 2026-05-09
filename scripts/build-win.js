/**
 * Build Windows con electron-packager.
 * Por defecto incrementa semver en package.json según el tipo (solo al ejecutar este script, no en npm start).
 * Uso: node scripts/build-win.js [patch|minor|major] [--no-bump]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');

function bumpSemver(version, kind) {
  const parts = String(version).split('.').map((x) => parseInt(x, 10));
  const maj = Number.isFinite(parts[0]) ? parts[0] : 0;
  const min = Number.isFinite(parts[1]) ? parts[1] : 0;
  const pat = Number.isFinite(parts[2]) ? parts[2] : 0;
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const argv = process.argv.slice(2);
const noBump = argv.includes('--no-bump');
let kind = 'patch';
if (argv.includes('major')) kind = 'major';
else if (argv.includes('minor')) kind = 'minor';
else if (argv.includes('patch')) kind = 'patch';

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (!noBump) {
  pkg.version = bumpSemver(pkg.version, kind);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`Versión actualizada a ${pkg.version} (${kind})`);
}

const version = pkg.version;
// Sin espacios en el nombre de carpeta (evita problemas con accesos directos y algunas políticas de Windows).
const outName = `notas-rapidas-v${version}`;
const exeBaseName = pkg.name || 'notas-rapidas';

const args = [
  'electron-packager',
  '.',
  outName,
  '--platform=win32',
  '--arch=x64',
  '--out=dist',
  '--overwrite',
  '--icon=assets/icon.ico',
  `--executable-name=${exeBaseName}`
];

const result = spawnSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env
});

const code = result.status !== null && result.status !== undefined ? result.status : 1;
if (code !== 0) {
  process.exit(code);
}

const distFolder = path.join(root, 'dist', `${outName}-win32-x64`);
const exePath = path.join(distFolder, `${exeBaseName}.exe`);
let statOk = false;
let exeSize = 0;
let statErr = null;
try {
  const st = fs.statSync(exePath);
  statOk = true;
  exeSize = st.size;
} catch (e) {
  statErr = e && e.message ? e.message : 'unknown';
}
console.log(`Ejecutable: ${exePath}`);
if (!statOk) {
  console.error('No se pudo verificar el .exe generado. Revisa la salida de electron-packager.');
  process.exit(1);
}

process.exit(0);
