import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../scripts/publication-preflight.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'publication-check-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(root, 'README.md'), '# Public fixture\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'public');
  return root;
}

test('preflight scans committed content and excludes untracked local files', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, '.env'), 'private local setup');
    const result = spawnSync(process.execPath, [cli], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).files, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight refuses a committed private configuration even without a token', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, '.env'), 'LOCAL_SETTING=value\n');
    git(root, 'add', '-f', '.env'); git(root, 'commit', '-qm', 'private setting');
    const result = spawnSync(process.execPath, [cli], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('scanner rejects fake secrets despite staged and inline suppression', () => {
  const root = fixture();
  try {
    const token = ['ghp_16C7e42F292c6912', 'E7710c838347Ae178B4a'].join('');
    writeFileSync(path.join(root, 'leak.txt'), `token=${token} # gitleaks:allow\n`);
    writeFileSync(path.join(root, '.gitleaks.toml'), '[allowlist]\nregexes = [".*"]\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'synthetic secret');
    const result = spawnSync(process.execPath, [cli], { cwd: root,
      env: { ...env, GITLEAKS_CONFIG: path.join(root, '.gitleaks.toml') }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gitleaks failed/);
    assert.ok(!result.stderr.includes(token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight refuses escaping committed symlinks', () => {
  const root = fixture();
  try {
    symlinkSync('/outside/publication', path.join(root, 'escape'));
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'unsafe symlink');
    const result = spawnSync(process.execPath, [cli], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight refuses when the scanner is unavailable', () => {
  const root = fixture();
  try {
    const tools = path.join(root, 'tools'); mkdirSync(tools);
    const binary = (env.PATH ?? '').split(path.delimiter).map(p => path.join(p, 'git')).find(existsSync);
    assert.ok(binary);
    symlinkSync(binary, path.join(tools, 'git'));
    const result = spawnSync(process.execPath, [cli], { cwd: root, env: { ...env, PATH: tools }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gitleaks failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight permits an internal link without reading outside the committed tree', () => {
  const root = fixture();
  try {
    symlinkSync('README.md', path.join(root, 'readme-link'));
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'internal link');
    const result = spawnSync(process.execPath, [cli], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).files, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preflight refuses the existing private-home literal policy', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, 'notes.txt'), '/Users/' + ['james', 'debatty'].join('') + '/private\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'private home');
    const result = spawnSync(process.execPath, [cli], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private literal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
