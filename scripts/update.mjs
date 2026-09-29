#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, realpathSync, statSync, existsSync, mkdirSync, renameSync, symlinkSync, openSync, appendFileSync } from 'node:fs'
import { dirname, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIPv4 } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const [command, configPath, version] = process.argv.slice(2)
let log
const output = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', log ?? 'inherit'], ...options }).trim()
const run = (tool, args, options = {}) => execFileSync(tool, args, { stdio: ['inherit', log ?? 'inherit', log ?? 'inherit'], ...options })
let stopped = false
try {
  if (!['check', 'update'].includes(command) || !isAbsolute(configPath ?? '')) throw Error('Usage: update.mjs check|update /absolute/production.json vMAJOR.MINOR.PATCH')
  run(process.execPath, [resolve(here, 'release.mjs'), 'version', version])
  const c = JSON.parse(readFileSync(configPath, 'utf8'))
  // Compose 会插值美元符号；配置只接受普通字符串，避免显式路径被 shell 环境重新解释。
  if (Object.values(c).some(value => typeof value !== 'string' || /[\x00-\x1f$]/.test(value))) throw Error('Configuration must contain plain strings without control characters or dollar interpolation')
  if (!/^[a-z0-9][a-z0-9-]+$/.test(c.project) || c.project.includes('dev')) throw Error('Use a distinct production project')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(c.network) || c.network.includes('dev')) throw Error('Use a dedicated production network')
  const origin = new URL(c.origin)
  if (origin.protocol !== 'https:' || origin.origin !== c.origin) throw Error('Use an exact HTTPS origin')
  for (const key of ['backendIp', 'trustedProxy']) if (!isIPv4(c[key]) || c[key] === '0.0.0.0') throw Error(`Invalid ${key}`)
  const paths = ['databaseDir', 'filesDir', 'webRoot'].map(key => {
    if (!isAbsolute(c[key] ?? '') || c[key].includes(',') || realpathSync(c[key]) !== c[key] || !statSync(c[key]).isDirectory() || c[key] === '/') throw Error(`Invalid existing absolute ${key}`)
    return c[key]
  })
  for (const a of paths) for (const b of paths) if (a !== b && a.startsWith(b + sep)) throw Error('Deployment paths must not be nested')
  if (new Set(paths).size !== paths.length) throw Error('Deployment paths must be separate')
  const configDir = dirname(realpathSync(configPath))
  if (paths.some(path => configDir === path || configDir.startsWith(path + sep))) throw Error('Configuration and logs must stay outside storage and static directories')
  if (command === 'check') { console.log('Configuration valid; runtime and network not checked.'); process.exit(0) }
  const logPath = resolve(configDir, `update-${Date.now()}-${process.pid}.log`)
  log = openSync(logPath, 'wx', 0o600)
  console.log(`Update output retained in ${logPath}`)
  // flock 子进程与本进程共享同一个打开的文件描述；子进程退出后，本进程仍持锁。
  // 不用环境变量证明持锁，也不递归执行更新；锁描述符一直保留到本进程退出。
  const lock = openSync('/run/lock/filehop-update.lock', 'a')
  const locked = spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', log, log, lock] })
  if (locked.error) throw locked.error
  if (locked.status !== 0) throw Error('Another update holds the lock; no update operations performed')
  console.log('Confirm transfers have ended and drafts are saved. Refresh Web after completion. No automatic rollback.')
  if (process.env.FILEHOP_CONFIRM_STOP !== 'yes') throw Error('Set FILEHOP_CONFIRM_STOP=yes after ending transfers and saving drafts')
  const state = dirname(realpathSync(configPath))
  const target = resolve(c.webRoot, version)
  if (existsSync(target)) throw Error('Target directory already exists; inspect previous attempt manually')
  const release = JSON.parse(output('gh', ['release', 'view', version, '--repo', 'nt1r/FileHop', '--json', 'tagName,isDraft,isPrerelease']))
  if (release.tagName !== version || release.isDraft || release.isPrerelease) throw Error('Not a completed stable release')
  mkdirSync(target)
  // 只下载数据，不执行 Release 中的脚本。失败留下目录供人工核查，禁止自动覆盖重跑。
  run('gh', ['release', 'download', version, '--repo', 'nt1r/FileHop', '--pattern', 'release.json', '--dir', target])
  const manifest = JSON.parse(output(process.execPath, [resolve(here, 'release.mjs'), 'manifest', version, resolve(target, 'release.json')]))
  for (const image of [manifest.backend, manifest.web]) {
    run('docker', ['pull', '--platform', 'linux/arm64', image])
    const [info] = JSON.parse(output('docker', ['image', 'inspect', image]))
    if (info.Os !== 'linux' || info.Architecture !== 'arm64' || info.Config.Labels?.['org.opencontainers.image.revision'] !== manifest.sha || info.Config.Labels?.['org.opencontainers.image.version'] !== version) throw Error('Image architecture or release identity mismatch')
  }
  const extract = output('docker', ['create', manifest.web, '/unused'])
  try { run('docker', ['cp', `${extract}:/web/.`, target]) } finally { run('docker', ['rm', extract]) }
  if (!statSync(resolve(target, 'index.html')).isFile()) throw Error('Missing static index')
  const composeFile = resolve(state, 'target.compose.json')
  const compose = { name: c.project, services: { backend: {
    image: manifest.backend, init: true, command: ['serve', '--require-initialized'], restart: 'unless-stopped', stop_grace_period: '30s',
    environment: { FILEHOP_ORIGIN: c.origin, FILEHOP_TRUSTED_PROXY: c.trustedProxy },
    volumes: [c.databaseDir, c.filesDir].map((source, i) => ({ type: 'bind', source, target: ['/data/database', '/data/files'][i], bind: { create_host_path: false } })),
    networks: { ingress: { ipv4_address: c.backendIp, aliases: ['filehop-prod-backend'] } },
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  } }, networks: { ingress: { external: true, name: c.network } } }
  // 待迁移配置仅用于校验和停服；迁移成功前不能覆盖日常运行入口，避免失败后误启新版本。
  const pendingCompose = resolve(state, `pending-${version}-${process.pid}.compose.json`)
  writeFileSync(pendingCompose, JSON.stringify(compose, null, 2), { mode: 0o600, flag: 'wx' })
  // 不接受 shell 的 Compose 覆盖项；所有持久路径来自上述显式配置，不从源码目录推导。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')))
  const args = ['compose', '--env-file', '/dev/null', '--project-directory', state, '-p', c.project, '-f', pendingCompose]
  const dc = (...tail) => run('docker', [...args, ...tail], { env })
  dc('config', '--quiet')
  const ids = output('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${c.project}`]).split('\n').filter(Boolean)
  if (ids.length !== 1) throw Error('Update requires exactly one existing backend; initialize separately')
  const [old] = JSON.parse(output('docker', ['inspect', ids[0]]))
  if (old.Config.Labels?.['com.docker.compose.service'] !== 'backend' ||
      ![c.databaseDir, c.filesDir].every((source, i) => old.Mounts.some(m => m.Type === 'bind' && m.Source === source && m.Destination === ['/data/database', '/data/files'][i]))) throw Error('Existing project does not own the configured storage')
  // 停旧写入者后才运行目标 migrate。后端自身的存储锁继续阻止项目外的并发写入。
  dc('stop', 'backend')
  stopped = true
  run('docker', ['run', '--rm', '--network', 'none',
    '--mount', `type=bind,src=${c.databaseDir},dst=/data/database`,
    '--mount', `type=bind,src=${c.filesDir},dst=/data/files`, manifest.backend, 'migrate'])
  // 数据已由目标镜像迁移成功后，才原子替换运行配置；后续启动失败也保留目标配置供排障。
  renameSync(pendingCompose, composeFile)
  args[args.length - 1] = composeFile
  // 完整资源提取完成后用原子符号链接切换；共享 Caddy 配置始终指向 webRoot/current。
  const link = resolve(c.webRoot, `.current-${process.pid}`)
  symlinkSync(target, link)
  renameSync(link, resolve(c.webRoot, 'current'))
  dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'backend')
  const deadline = Date.now() + 60000
  while (true) {
    try {
      const ready = JSON.parse(output('curl', ['--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '2', `http://${c.backendIp}:8080/internal/ready`], { stdio: ['ignore', 'pipe', 'pipe'] }))
      if (ready.database_available === true && ready.uploads_ready === true) break
    } catch { /* 只重试有期限的只读就绪探测，不重跑迁移或业务写入。 */ }
    if (Date.now() >= deadline) throw Error('Target did not become ready')
    await new Promise(r => setTimeout(r, 500))
  }
  const status = JSON.parse(output('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', `${c.origin}/api/status`]))
  if (status.state !== 'initialized') throw Error('HTTPS API smoke failed')
  const html = output('curl', ['--fail', '--silent', '--show-error', '--max-time', '10', c.origin])
  if (html !== readFileSync(resolve(target, 'index.html'), 'utf8').trim()) throw Error('HTTPS static version mismatch')
  writeFileSync(resolve(state, 'current-release.json.tmp'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  renameSync(resolve(state, 'current-release.json.tmp'), resolve(state, 'current-release.json'))
  const completed = `Updated to ${version} (${manifest.sha}). Refresh Web and verify your daily exchange path.`
  appendFileSync(log, completed + '\n')
  console.log(completed)
} catch (error) {
  const guidance = stopped ? 'Update stopped after stopping the old backend. Preserve data/logs; inspect the target manually. Do not restart the old version or blindly rerun.' : 'Update aborted. Preserve downloaded artifacts and inspect configuration.'
  if (log !== undefined) appendFileSync(log, `${error.message}\n${guidance}\n`)
  console.error(error.message)
  console.error(guidance)
  process.exitCode = 1
}
