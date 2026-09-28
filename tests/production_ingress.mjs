import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { once } from 'node:events'

const [root, port] = process.argv.slice(2)
const ca = readFileSync(`${root}/cert.pem`)
const hash = spawnSync('caddy', ['hash-password'], { input: 'synthetic-ingress-password\n', encoding: 'utf8' })
assert.equal(hash.status, 0)
writeFileSync(`${root}/Caddyfile`, `{
 admin off
 auto_https disable_redirects
 servers {
  protocols h1 h2
 }
}
https://localhost:${port} {
 bind 127.0.0.1
 tls ${root}/cert.pem ${root}/key.pem
 import ${process.cwd()}/deploy/caddy-production.routes
}
https://127.0.0.1:${port} {
 bind 127.0.0.1
 tls ${root}/cert.pem ${root}/key.pem
 import ${process.cwd()}/deploy/caddy-dev.routes
}
`)
const env = { ...process.env, NODE_EXTRA_CA_CERTS: `${root}/cert.pem`, XDG_DATA_HOME: `${root}/caddy-data`, XDG_CONFIG_HOME: `${root}/caddy-config`,
  FILEHOP_DEV_USER: 'test', FILEHOP_DEV_PASSWORD_HASH: hash.stdout.trim(),
  TEST_BASE_URL: `https://localhost:${port}`, TEST_DEV_URL: `https://127.0.0.1:${port}`, TEST_PRODUCTION_ROOT: root }
const config = ['--config', `${root}/Caddyfile`, '--adapter', 'caddyfile']
assert.equal(spawnSync('caddy', ['validate', ...config], { env, stdio: 'inherit' }).status, 0)
let caddy
let browserChild
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true
  browserChild?.kill(signal)
  caddy?.kill('SIGTERM')
})
let logs = ''
async function stop() {
  if (caddy && caddy.exitCode === null) { caddy.kill('SIGTERM'); await once(caddy, 'exit') }
}
async function start() {
  if (interrupted) throw new Error('Interrupted')
  caddy = spawn('caddy', ['run', ...config], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  caddy.stdout.on('data', b => { logs += b }); caddy.stderr.on('data', b => { logs += b })
  const deadline = Date.now() + 15000
  while (true) {
    try {
      const status = await new Promise((resolve, reject) => {
        const req = https.get({ host: '127.0.0.1', servername: 'localhost', port, path: '/api/status', ca,
          headers: { Host: `localhost:${port}` }, timeout: 1000 }, res => {
          let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve(body))
        })
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')))
      })
      if (JSON.parse(status).state === 'initialized') break
    } catch { /* 只在有期限的启动探测中重试，业务测试不重试。 */ }
    if (Date.now() > deadline || caddy.exitCode !== null) throw new Error(`Ingress not ready: ${logs}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
async function browser(phase) {
  if (interrupted) throw new Error('Interrupted')
  const child = browserChild = spawn('pnpm', ['-C', 'web', 'run', 'test:e2e', 'production.test.ts'], {
    env: { ...env, TEST_PRODUCTION_PHASE: phase }, stdio: 'inherit',
  })
  assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }), 0)
}
try {
  await start()
  await browser('seed')
  await stop()
  // 保留两个数据挂载以及入口证书/静态目录，重建应用后重新解析内部地址。
  const compose = JSON.parse(process.env.FILEHOP_TEST_PROD_COMPOSE)
  // 最近实际发布镜像负责种数据；首次发布时与目标相同，不伪造跨结构升级证据。
  const targetEnv = { ...process.env, FILEHOP_PROD_BACKEND_IMAGE: process.env.FILEHOP_BACKEND_IMAGE || 'filehop-issue6-backend' }
  // 目标镜像必须拒绝与旧写入者并发迁移；停旧后迁移再启动，验证原消息/文件保留。
  assert.notEqual(spawnSync('docker', [...compose, 'run', '--rm', '-T', '--no-deps', 'backend', 'migrate'], { stdio: 'inherit', env: targetEnv }).status, 0)
  assert.equal(spawnSync('docker', [...compose, 'stop', 'backend'], { stdio: 'inherit' }).status, 0)
  assert.equal(spawnSync('docker', [...compose, 'run', '--rm', '-T', '--no-deps', 'backend', 'migrate'], { stdio: 'inherit', env: targetEnv }).status, 0)
  assert.equal(spawnSync('docker', [...compose, 'up', '-d', '--no-build', '--force-recreate'], { stdio: 'inherit', env: targetEnv }).status, 0)
  const id = spawnSync('docker', [...compose, 'ps', '-q', 'backend'], { encoding: 'utf8' })
  assert.equal(id.status, 0)
  const ip = spawnSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', id.stdout.trim()], { encoding: 'utf8' })
  assert.equal(ip.status, 0)
  env.FILEHOP_PROD_BACKEND_UPSTREAM = `${ip.stdout.trim()}:8080`
  const deadline = Date.now() + 15000
  while (true) {
    try {
      const response = await fetch(`http://${env.FILEHOP_PROD_BACKEND_UPSTREAM}/internal/ready`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        assert.deepEqual(await response.json(), { database_available: true, uploads_ready: true })
        break
      }
    } catch { /* 启动时只读就绪探测允许限时重试。 */ }
    assert.ok(Date.now() < deadline, 'Target image must become ready after migration')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await start()
  await browser('verify')
} finally {
  await stop()
  writeFileSync(`${root}/caddy.log`, logs)
}
