import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@cloudflare/kumo/components/button'

type Session = { expires_at: number; server_time: number }
type Phase = 'checking' | 'login' | 'authenticated' | 'unknown' | 'logout-pending'
type LogoutNotice = 'logout-pending' | 'logged-out'
class ApplicationError extends Error {
  code: string
  retryAfter: number
  constructor(code: string, message: string, retryAfter = 0) { super(message); this.code = code; this.retryAfter = retryAfter }
}
async function request(method: 'GET' | 'POST', credentials?: { username: string; password: string }): Promise<Session>
async function request(method: 'DELETE'): Promise<void>
async function request(method: 'GET' | 'POST' | 'DELETE', credentials?: { username: string; password: string }): Promise<Session | void> {
  const response = await fetch('/api/session', {
    method, credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(method === 'POST' ? 30_000 : 15_000),
    ...(credentials ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) } : {}),
  })
  if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('访问层异常')
  }
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object') throw new Error('响应无效')
  if (!response.ok) {
    if (response.status === 429 && 'code' in value && value.code === 'login_limited') {
      const seconds = Number(response.headers.get('retry-after'))
      throw new ApplicationError('login_limited', '登录请求过多，请稍后重试', Number.isFinite(seconds) && seconds > 0 ? seconds : 60)
    }
    if ('code' in value && 'message' in value && typeof value.code === 'string' && typeof value.message === 'string') {
      if (response.status === 401 && (value.code === 'session_invalid' || value.code === 'invalid_credentials')) {
        throw new ApplicationError(value.code, value.message)
      }
    }
    throw new Error('应用或访问层暂不可用，请稍后重试')
  }
  if (method === 'DELETE') {
    if ('state' in value && value.state === 'logged_out') return
    throw new Error('退出响应无效')
  }
  if (!('expires_at' in value) || !('server_time' in value) ||
    typeof value.expires_at !== 'number' || typeof value.server_time !== 'number' ||
    !Number.isSafeInteger(value.expires_at) || !Number.isSafeInteger(value.server_time) ||
    value.expires_at <= value.server_time || value.expires_at - value.server_time > 43_200) throw new Error('响应无效')
  return value as Session
}

export default function SessionPage() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [message, setMessage] = useState('正在恢复登录…')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryAt, setRetryAt] = useState(0)
  const [retryReady, setRetryReady] = useState(true)
  const generation = useRef(0)
  const logoutPending = useRef(false)
  const channel = useRef<BroadcastChannel | null>(null)
  const deadline = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const remaining = retryAt - Date.now()
    setRetryReady(remaining <= 0)
    if (remaining <= 0) return
    const timer = setTimeout(() => setRetryReady(true), remaining)
    return () => clearTimeout(timer)
  }, [retryAt])

  function clearForLogout(notice: LogoutNotice) {
    // 通知只存在于当前打开的页面，不写持久化锁。先废弃所有在途回调，
    // 再清空页面；即使 Cookie 仍有效，也不能通过前台恢复或迟到响应重现内容。
    generation.current++
    logoutPending.current = notice === 'logout-pending'
    deadline.current = null
    clearTimeout(timer.current)
    setUsername('')
    setPassword('')
    setBusy(false)
    setPhase(notice === 'logout-pending' ? 'logout-pending' : 'login')
    setMessage(notice === 'logout-pending'
      ? '退出未确认：当前页面已清空，服务器登录状态尚未确认撤销。可重试退出；刷新或新开页面仍可能恢复有效登录。'
      : '已退出 FileHop 登录。此操作不会清除浏览器的外层 Basic Auth。')
  }
  async function logout() {
    clearForLogout('logout-pending')
    channel.current?.postMessage('logout-pending')
    const version = generation.current
    setBusy(true)
    try {
      await request('DELETE')
      if (version !== generation.current) return
      clearForLogout('logged-out')
      channel.current?.postMessage('logged-out')
    } catch (error) {
      if (version !== generation.current) return
      if (error instanceof ApplicationError && error.code === 'session_invalid') {
        clearForLogout('logged-out')
        channel.current?.postMessage('logged-out')
      }
    } finally { if (version === generation.current) setBusy(false) }
  }

  function expire() {
    // 先使在途读取失效，再隐藏受保护内容；旧响应不能把页面带回已登录状态。
    generation.current++
    deadline.current = null
    clearTimeout(timer.current)
    setPhase('login')
    setMessage('登录已到期，请在当前页面重新登录。')
    setBusy(false)
  }
  function accept(value: Session, started: number) {
    // 使用服务端剩余时间并扣除整个请求耗时，避免本机时钟偏差或迟到响应延长会话。
    const remaining = (value.expires_at - value.server_time) * 1000 - (Date.now() - started)
    if (remaining <= 0) { expire(); return }
    deadline.current = Date.now() + remaining
    clearTimeout(timer.current)
    timer.current = setTimeout(expire, remaining)
    setPhase('authenticated')
    setMessage('登录成功。')
    setPassword('')
  }
  async function check(initial = false) {
    if (logoutPending.current) return
    const version = ++generation.current
    const started = Date.now()
    setBusy(true)
    try {
      const session = await request('GET')
      if (version === generation.current) accept(session, started)
    } catch (error) {
      if (version !== generation.current) return
      if (error instanceof ApplicationError && error.code === 'session_invalid') {
        deadline.current = null
        clearTimeout(timer.current)
        setPhase('login')
        setMessage(initial ? '已初始化，请登录。' : '请重新登录。')
        // 新开页面也可能先确认 Cookie 已失效；只让正在退出的页面收敛，
        // 不把普通到期通知误当成主动丢弃草稿的指令。
        channel.current?.postMessage('session-invalid')
      } else {
        // 网络及外层 401 不是应用注销；已验证页面保留，未知登录则只允许查询确认。
        setPhase(current => current === 'authenticated' ? current : 'unknown')
        setMessage('无法确认登录状态，请检查网络或访问层后重试检查。')
      }
    } finally { if (version === generation.current) setBusy(false) }
  }
  useEffect(() => {
    const notices = new BroadcastChannel('filehop-session')
    channel.current = notices
    notices.onmessage = (event: MessageEvent<unknown>) => {
      // 多个标签页同时重试时，重复待确认通知不能使彼此的退出成功回调失效。
      if (event.data === 'logout-pending' && !logoutPending.current) clearForLogout('logout-pending')
      else if (event.data === 'logged-out') clearForLogout('logged-out')
      else if (event.data === 'session-invalid' && logoutPending.current) clearForLogout('logged-out')
    }
    void check(true)
    const visible = () => {
      if (document.visibilityState !== 'visible') return
      if (deadline.current !== null && Date.now() >= deadline.current) expire()
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('pageshow', visible)
    const cleanup = () => { generation.current++; clearTimeout(timer.current) }
    return () => {
      cleanup()
      notices.close()
      channel.current = null
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('pageshow', visible)
    }
    // 初始化只执行一次；后续恢复由明确的用户动作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function login(event: FormEvent) {
    event.preventDefault()
    if (busy || phase !== 'login' || Date.now() < retryAt) return
    const version = ++generation.current
    const started = Date.now()
    setBusy(true)
    try {
      const session = await request('POST', { username, password })
      if (version === generation.current) accept(session, started)
    } catch (error) {
      if (version !== generation.current) return
      if (error instanceof ApplicationError && error.code === 'login_limited') {
        setRetryAt(Date.now() + error.retryAfter * 1000)
        setMessage('登录请求过多，请等待后重试。')
      } else if (error instanceof ApplicationError && error.code === 'invalid_credentials') {
        setMessage('用户名或密码错误')
      } else {
        // POST 响应丢失可能已设置 Cookie。先查询，绝不自动重复创建登录。
        setPhase('unknown')
        setMessage('登录结果未确认，正在检查当前会话…')
        setPassword('')
        await check()
      }
    } finally {
      if (version === generation.current) {
        setPassword('')
        setBusy(false)
      }
    }
  }

  return <section>
    <p role="status">{message}</p>
    {phase === 'authenticated' && <section aria-label="消息流"><h2>消息流</h2><p>暂无消息。文本发送将在后续任务开放。</p></section>}
    {phase === 'login' && <form onSubmit={login}>
      <label>用户名<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <Button type="submit" variant="primary" disabled={busy || !retryReady}>登录</Button>
    </form>}
    {phase === 'authenticated' && <Button onClick={() => void logout()}>退出登录</Button>}
    {phase === 'logout-pending' && <Button disabled={busy} onClick={() => void logout()}>重试退出</Button>}
    {(phase === 'unknown' || phase === 'authenticated') && <Button disabled={busy} onClick={() => void check()}>检查登录状态</Button>}
  </section>
}
