#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

try {
  const [command, version, file] = process.argv.slice(2)
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') || version.includes('\n')) throw Error('Invalid version; use vMAJOR.MINOR.PATCH')
  if (command === 'version') console.log(version)
  else if (command === 'source') {
    // tag 可以指向 main 的任一已合入提交；不把分支名或 tag 字符串当作构建身份。
    const sha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${version}^{commit}`], { encoding: 'utf8' }).trim()
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'])
    console.log(sha)
  } else if (command === 'manifest') {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (manifest.version !== version || !/^[a-f0-9]{40}$/.test(manifest.sha)) throw Error('Release identity mismatch')
    for (const component of ['backend', 'web']) {
      const pattern = new RegExp(`^ghcr\\.io/nt1r/filehop-${component}@sha256:[a-f0-9]{64}$`)
      if (!pattern.test(manifest[component])) throw Error(`Invalid ${component} artifact`)
    }
    console.log(JSON.stringify(manifest))
  } else throw Error('Usage: release.mjs version|source VERSION, or manifest VERSION FILE')
} catch (error) { console.error(error.message); process.exitCode = 1 }
