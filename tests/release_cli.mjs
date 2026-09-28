import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const cli = resolve('scripts/release.mjs')
const root = mkdtempSync(join(tmpdir(), 'filehop-release-test-'))
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
try {
  assert.equal(run('version', 'v1.2.3').status, 0)
  for (const version of ['latest', 'v01.2.3', 'v1.2', 'v1.2.3-rc1', 'v1.2.3\n', '../v1.2.3']) {
    assert.notEqual(run('version', version).status, 0, version)
  }
  const manifest = { version: 'v1.2.3', sha: 'a'.repeat(40),
    backend: `ghcr.io/nt1r/filehop-backend@sha256:${'b'.repeat(64)}`,
    web: `ghcr.io/nt1r/filehop-web@sha256:${'c'.repeat(64)}` }
  const file = join(root, 'release.json')
  writeFileSync(file, JSON.stringify(manifest))
  assert.equal(run('manifest', 'v1.2.3', file).status, 0)
  for (const change of [{ version: 'v2.0.0' }, { sha: 'main' },
    { backend: 'ghcr.io/other/backend:latest' }, { web: manifest.backend }]) {
    writeFileSync(file, JSON.stringify({ ...manifest, ...change }))
    assert.notEqual(run('manifest', 'v1.2.3', file).status, 0)
  }
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  git('add', '.'); git('commit', '-qm', 'initial')
  const sha = git('rev-parse', 'HEAD').stdout.trim()
  git('update-ref', 'refs/remotes/origin/main', sha)
  git('tag', 'v1.2.3')
  assert.equal(spawnSync(process.execPath, [cli, 'source', 'v1.2.3'], { cwd: root, encoding: 'utf8' }).stdout.trim(), sha)
  writeFileSync(join(root, 'unreleased'), 'not on main')
  git('add', '.'); git('commit', '-qm', 'unreleased'); git('tag', 'v1.2.4')
  assert.notEqual(spawnSync(process.execPath, [cli, 'source', 'v1.2.4'], { cwd: root }).status, 0)
  console.log('Release version, main ancestry and artifact validation passed.')
} finally { rmSync(root, { recursive: true }) }
