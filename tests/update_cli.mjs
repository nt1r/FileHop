import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'filehop-update-test-'))
const cli = resolve('scripts/update.mjs')
try {
  for (const dir of ['database', 'files', 'web']) mkdirSync(join(root, dir))
  const config = { project: 'filehop-production', databaseDir: join(root, 'database'), filesDir: join(root, 'files'),
    webRoot: join(root, 'web'), network: 'filehop-production-ingress', backendIp: '192.0.2.11',
    trustedProxy: '192.0.2.10', origin: 'https://filehop.example.invalid' }
  const path = join(root, 'production.json')
  const run = (value, version = 'v1.2.3') => {
    writeFileSync(path, JSON.stringify(value))
    return spawnSync(process.execPath, [cli, 'check', path, version], { encoding: 'utf8' })
  }
  assert.equal(run(config).status, 0)
  for (const change of [{ databaseDir: '.' }, { filesDir: config.databaseDir },
    { webRoot: config.databaseDir }, { project: 'filehop-dev' }, { origin: 'http://localhost' },
    { backendIp: '0.0.0.0' }, { filesDir: join(root, 'missing') }, { databaseDir: '$HOME/data' }]) {
    assert.notEqual(run({ ...config, ...change }).status, 0, JSON.stringify(change))
  }
  assert.notEqual(run(config, '../latest').status, 0)
  console.log('Update CLI rejects unsafe configuration before Docker or download.')
  const bin = join(root, 'bin'); mkdirSync(bin)
  const manifest = { version: 'v1.2.3', sha: 'a'.repeat(40), backend: `ghcr.io/nt1r/filehop-backend@sha256:${'b'.repeat(64)}`, web: `ghcr.io/nt1r/filehop-web@sha256:${'c'.repeat(64)}` }
  const log = join(root, 'calls')
  const fake = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const tool = path.basename(process.argv[1]); const args = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(process.env.CONFIG));
const m = JSON.parse(process.env.MANIFEST);
fs.appendFileSync(process.env.CALLS, JSON.stringify([tool,...args])+'\\n');
if (tool === 'gh') {
 const contender = require('child_process').spawnSync('flock', ['--nonblock', '/run/lock/filehop-update.lock', 'true']);
 if (contender.status !== 1) process.exit(8);
 if (args[1] === 'view') console.log(JSON.stringify({tagName:m.version,isDraft:false,isPrerelease:false}));
 else fs.writeFileSync(path.join(args[args.indexOf('--dir')+1],'release.json'),JSON.stringify(m));
} else if (tool === 'curl') {
 const url=args.at(-1);
 if (url === c.origin + process.env.FAIL_PAGE) { console.error('Synthetic HTTP 404'); process.exit(22); }
 if (url === c.origin + process.env.WRONG_PAGE) { console.log('<html>wrong version</html>'); process.exit(0); }
 console.log(url.endsWith('/internal/ready') ? JSON.stringify({database_available:true,uploads_ready:true}) : url.endsWith('/api/status') ? JSON.stringify({state:'initialized'}) : '<html>synthetic</html>');
} else if (args[0] === 'image') console.log(JSON.stringify([{Os:'linux',Architecture:process.env.BAD_ARCH ? 'amd64' : 'arm64',Config:{Labels:{'org.opencontainers.image.revision':m.sha,'org.opencontainers.image.version':m.version}}}]));
else if (args[0] === 'create') console.log('extract-id');
else if (args[0] === 'cp') fs.writeFileSync(path.join(args.at(-1),'index.html'),'<html>synthetic</html>');
else if (args[0] === 'ps') console.log('existing-id');
else if (args[0] === 'inspect') console.log(JSON.stringify([{Config:{Labels:{'com.docker.compose.service':process.env.WRONG_OWNER ? 'other' : 'backend'}},Mounts:[{Type:'bind',Source:c.databaseDir,Destination:'/data/database'},{Type:'bind',Source:c.filesDir,Destination:'/data/files'}]}]));
else if (args.includes('migrate')) {
 if (fs.readFileSync(path.join(path.dirname(process.env.CONFIG), 'target.compose.json'), 'utf8') !== process.env.PREVIOUS_COMPOSE) process.exit(10);
 if (process.env.FAIL_MIGRATE === 'yes') { console.error('Synthetic migration failure'); process.exit(9); }
}
`
  for (const tool of ['docker', 'gh', 'curl']) writeFileSync(join(bin, tool), fake, { mode: 0o755 })
  writeFileSync(path, JSON.stringify(config))
  writeFileSync(join(config.databaseDir, 'sentinel'), 'preserve synthetic data')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONFIG: path, CALLS: log, MANIFEST: JSON.stringify(manifest), FILEHOP_CONFIRM_STOP: 'yes' }
  const update = extra => spawnSync(process.execPath, [cli, 'update', path, 'v1.2.3'], { encoding: 'utf8', env: { ...env, ...extra } })
  const locked = spawnSync('flock', ['--nonblock', '/run/lock/filehop-update.lock', process.execPath, cli, 'update', path, 'v1.2.3'], { encoding: 'utf8', env })
  assert.notEqual(locked.status, 0, 'A second updater must fail before downloads')
  assert.ok(!existsSync(log))
  const forgedLock = spawnSync('flock', ['--nonblock', '/run/lock/filehop-update.lock', process.execPath, cli, 'update', path, 'v1.2.3'], {
    encoding: 'utf8', env: { ...env, FILEHOP_UPDATE_LOCKED: '1' },
  })
  assert.notEqual(forgedLock.status, 0, 'An inherited environment flag must not bypass the real lock')
  assert.ok(!existsSync(log), 'Lock conflict must not download or invoke Docker even with an inherited flag')
  assert.notEqual(update({ BAD_ARCH: 'yes' }).status, 0)
  assert.ok(!readFileSync(log, 'utf8').includes('"stop"'), 'Invalid architecture must not stop the old backend')
  config.webRoot = join(root, 'web-migration'); mkdirSync(config.webRoot)
  writeFileSync(path, JSON.stringify(config))
  const activeCompose = join(root, 'target.compose.json')
  const previousCompose = JSON.stringify({ name: config.project, services: { backend: { image: 'synthetic-previous-image' } } })
  writeFileSync(activeCompose, previousCompose)
  env.PREVIOUS_COMPOSE = previousCompose
  assert.notEqual(update({ WRONG_OWNER: 'yes' }).status, 0)
  assert.equal(readFileSync(activeCompose, 'utf8'), previousCompose, 'Ownership rejection must preserve runtime configuration')
  assert.ok(!readFileSync(log, 'utf8').includes('"stop"'))
  config.webRoot = join(root, 'web-migration-failure'); mkdirSync(config.webRoot)
  writeFileSync(path, JSON.stringify(config))
  assert.notEqual(update({ FAIL_MIGRATE: 'yes' }).status, 0)
  assert.ok(readdirSync(root).filter(name => name.startsWith('update-')).some(name =>
    readFileSync(join(root, name), 'utf8').includes('Synthetic migration failure')), 'Migration diagnostics must remain in the update log')
  assert.equal(readFileSync(activeCompose, 'utf8'), previousCompose, 'Migration failure must preserve the active runtime configuration')
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.some(args => args.includes('stop')))
  assert.ok(calls.some(args => args.includes('migrate')))
  assert.ok(!calls.some(args => args.includes('up')))
  assert.equal(readFileSync(join(config.databaseDir, 'sentinel'), 'utf8'), 'preserve synthetic data')
  assert.ok(!existsSync(join(root, 'current-release.json')))
  assert.notEqual(update({}).status, 0, 'Must refuse blindly rerunning a failed target')
  // 子路径未部署或返回错误版本时，不得记录更新成功；不自动改入口或回滚。
  for (const [index, failure] of [{ FAIL_PAGE: '/login' }, { FAIL_PAGE: '/files' }, { WRONG_PAGE: '/files' }].entries()) {
    config.webRoot = join(root, `web-route-failure-${index}`); mkdirSync(config.webRoot)
    writeFileSync(path, JSON.stringify(config))
    writeFileSync(activeCompose, previousCompose)
    const failed = update(failure)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /verify the installed Caddy page routes/)
    assert.ok(failed.stderr.includes(failure.FAIL_PAGE ?? failure.WRONG_PAGE))
    assert.ok(!existsSync(join(root, 'current-release.json')), 'Failed page smoke must not record a completed release')
    assert.equal(readFileSync(join(config.databaseDir, 'sentinel'), 'utf8'), 'preserve synthetic data')
  }
  writeFileSync(activeCompose, previousCompose)
  writeFileSync(log, '')
  // 新的隔离静态目录代表操作者调查后明确开始的新一次更新，不由脚本自动清理失败现场。
  config.webRoot = join(root, 'web-success'); mkdirSync(config.webRoot)
  writeFileSync(path, JSON.stringify(config))
  const success = update({})
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(readFileSync(join(root, 'current-release.json'))).version, 'v1.2.3')
  assert.equal(JSON.parse(readFileSync(activeCompose)).services.backend.image, manifest.backend)
  const successCalls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  for (const page of ['/', '/login', '/files']) {
    assert.ok(successCalls.some(args => args[0] === 'curl' && args.at(-1) === config.origin + page), `Missing page smoke: ${page}`)
  }
  console.log('Update failures preserve data; all three page routes must match before recording success.')
} finally { rmSync(root, { recursive: true }) }
