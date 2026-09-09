#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const privateRules = [
  {
    "anchor": "@",
    "before": 13,
    "length": 23,
    "sha256": "9bd0007ec5ec43c3e7414c433a8584a4edbaedaed07e182380b5a810e722c570"
  },
  {
    "anchor": "/Users/",
    "before": 0,
    "length": 19,
    "sha256": "fd14d8e4674fa6ac3d9d24de4aaacf9346d1682485d1a1347dcaef38b3c131b9"
  },
  {
    "anchor": "Nova",
    "before": 0,
    "length": 8,
    "sha256": "84fa6ad0b876976c32f364ccdf44d38bc3568c6fc5407f8eaad0213417273a76"
  },
  {
    "anchor": "Nova",
    "before": 0,
    "length": 9,
    "sha256": "4fc77fca7f4775c511b47c263115ec0742be4a3bf8a51048892746fe41e24f1f"
  },
  {
    "anchor": "agent-",
    "before": 0,
    "length": 22,
    "sha256": "d41a498ed878ea4619dc7c80bdc4cdec0c6300a7ba4e65f7b8d8a7a41eb8e634"
  }
];

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('GITLEAKS_')));
function command(program, args, cwd = process.cwd()) {
  const result = spawnSync(program, args, { cwd, env, maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr.toString().slice(-1000)}`);
  return result.stdout;
}
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'publication-preflight-')));
try {
  const revision = command('git', ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const stage = path.join(scratch, 'tree'); mkdirSync(stage);
  const inside = value => {
    const relative = path.relative(stage, value);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const links = [];
  const entries = command('git', ['ls-tree', '-rz', '--full-tree', revision]).toString().split('\0').filter(Boolean);
  for (const entry of entries) {
    const split = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, split).split(' ');
    const name = entry.slice(split + 1);
    if (name === '.githooks/identity.local.sh' || name === 'docs/release.md' || name.split('/').includes('.env')) {
      throw new Error(`private path in committed publication tree: ${name}`);
    }
    if (!['100644', '100755', '120000'].includes(mode) || type !== 'blob' || /[\x00-\x1f\x7f\ufffd]/.test(name) || path.isAbsolute(name) || name.split('/').some(part => ['.', '..', '.git'].includes(part))) {
      throw new Error('unsafe path or non-regular file in committed publication tree');
    }
    const destination = path.join(stage, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    const content = command('git', ['cat-file', 'blob', oid]);
    for (const rule of privateRules) {
      for (let found = content.indexOf(rule.anchor); found !== -1; found = content.indexOf(rule.anchor, found + 1)) {
        const start = found - rule.before;
        if (start >= 0 && createHash('sha256').update(content.subarray(start, start + rule.length)).digest('hex') === rule.sha256) {
          throw new Error(`private literal in committed publication tree: ${name}`);
        }
      }
    }
    if (mode === '120000') {
      const target = content.toString();
      if (path.isAbsolute(target) || !inside(path.resolve(path.dirname(destination), target))) throw new Error('unsafe link outside committed tree');
      links.push({ destination, target, content });
    } else writeFileSync(destination, content);
  }
  for (const link of links) symlinkSync(link.target, link.destination);
  for (const link of links) if (!inside(realpathSync(link.destination))) throw new Error('unsafe link outside committed tree');
  for (const link of links) { unlinkSync(link.destination); writeFileSync(link.destination, link.content); }
  const config = path.join(scratch, 'scanner.toml');
  const ignore = path.join(scratch, 'ignore');
  writeFileSync(config, '[extend]\nuseDefault = true\n'); writeFileSync(ignore, '');
  const report = command('gitleaks', ['dir', stage, '--redact', '--no-banner', '--config', config,
    '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow', '--report-format', 'json', '--report-path', '-'], scratch);
  const findings = JSON.parse(report.toString());
  if (!Array.isArray(findings) || findings.length !== 0) throw new Error('scanner did not return a clean report');
  console.log(JSON.stringify({ revision, files: entries.length, scanner: 'gitleaks', passed: true }));
} catch (error) {
  console.error(`Publication preflight refused: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
