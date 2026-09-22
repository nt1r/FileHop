import { useEffect, useRef, useState } from 'react'

export type Message = { id: string; send_id: string; text: string; source_label: string; created_at: string }
type Attempt = { send_id: string; text: string; source_label: string; state: 'sending' | 'unknown' }
type Model = { draft: string; attempt: Attempt | null; messages: Message[]; syncCursor: string | null; before: string | null; hasOlder: boolean; historyNotice: string; notice: string; reading: boolean }
const unknownNotice = '结果未确认：正文与发送标识已保留，请主动读取历史确认；不会自动重发。'
const empty = (): Model => ({ draft: '', attempt: null, messages: [], syncCursor: null, before: null, hasOlder: false, historyNotice: '', notice: '', reading: false })
const space = '\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
export const normalizeLabel = (value: string) => value.replace(new RegExp(`^[${space}]+|[${space}]+$`, 'g'), '')
export function validText(value: string) {
  return !new RegExp(`^[${space}]*$`).test(value) && new TextEncoder().encode(value).length <= 65536
}
export const validLabel = (value: string) => [...normalizeLabel(value)].length >= 1 && [...normalizeLabel(value)].length <= 64
const labelKey = 'filehop-source-label'
function savedLabel() {
  try { const value = localStorage.getItem(labelKey); return value && validLabel(value) ? normalizeLabel(value) : 'Web' } catch { return 'Web' }
}
function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const m = value as Message
  return typeof m.id === 'string' && /^[1-9][0-9]*$/.test(m.id) && typeof m.send_id === 'string' &&
    typeof m.text === 'string' && typeof m.source_label === 'string' && typeof m.created_at === 'string'
}
function matches(message: Message, attempt: Attempt) {
  return message.send_id === attempt.send_id && message.text === attempt.text && message.source_label === attempt.source_label
}
class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
async function request(body?: Attempt, before?: string) {
  const response = await fetch(before ? `/api/messages?before=${encodeURIComponent(before)}&limit=50` : '/api/messages', {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send_id: body.send_id, text: body.text, source_label: body.source_label }) } : {}),
  })
  if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw new Error('访问层异常')
  const value: unknown = await response.json()
  if (!response.ok) {
    if (value && typeof value === 'object' && 'code' in value && 'message' in value && typeof value.code === 'string' && typeof value.message === 'string') throw new ApiError(response.status, value.code, value.message)
    throw new Error('响应无效')
  }
  return value
}

export function useMessages(active: boolean, onExpired: () => void) {
  const [model, setModel] = useState<Model>(empty)
  const current = useRef(model)
  const [label, setLabel] = useState(savedLabel)
  const epoch = useRef(0)
  const enabled = useRef(active)
  enabled.current = active
  const expire = useRef(onExpired)
  expire.current = onExpired
  function update(next: Model) { current.current = next; setModel(next) }
  function suspend(clear: boolean) {
    epoch.current++
    enabled.current = false
    // 到期只隐藏并保留内存载荷；主动退出才丢弃。旧网络回调失去代次后不得恢复内容。
    update(clear ? empty() : { ...current.current, messages: [], syncCursor: null, before: null, hasOlder: false, historyNotice: '', reading: false,
      attempt: current.current.attempt ? { ...current.current.attempt, state: 'unknown' } : null,
      notice: current.current.attempt ? unknownNotice : current.current.notice })
  }
  function merge(messages: Message[], cursor?: string) {
    const state = current.current
    const merged = new Map(state.messages.map(m => [m.id, m]))
    for (const message of messages) merged.set(message.id, message)
    const confirmed = state.attempt && messages.some(m => matches(m, state.attempt!))
    update({ ...state, messages: [...merged.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1),
      // 只有完整读取成功才建立快照基线，本地发送响应不能挪动新增读取游标。
      syncCursor: cursor ?? state.syncCursor,
      ...(confirmed ? { draft: '', attempt: null, notice: '发送成功' } : {}) })
  }
  async function read(older = false) {
    if (!enabled.current || current.current.reading) return
    const boundary = older ? current.current.before : null
    if (older && (!boundary || !current.current.hasOlder)) return
    const version = epoch.current
    update({ ...current.current, reading: true, historyNotice: '' })
    try {
      const value = await request(undefined, boundary ?? undefined)
      if (version !== epoch.current || !enabled.current) return
      if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages) || !value.messages.every(isMessage) ||
        !('has_older' in value) || typeof value.has_older !== 'boolean' || !('before' in value) ||
        (value.before !== null && (typeof value.before !== 'string' || !/^[1-9][0-9]*$/.test(value.before)))) throw new Error('响应无效')
      const messages = value.messages as Message[]
      if (value.before !== (messages[0]?.id ?? null) || (value.has_older && !messages.length) ||
        messages.some((m, i) => (boundary !== null && BigInt(m.id) >= BigInt(boundary)) || (i > 0 && BigInt(m.id) <= BigInt(messages[i - 1].id)))) throw new Error('响应无效')
      let cursor: string | undefined
      if (!older) {
        if (!('sync_cursor' in value) || typeof value.sync_cursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.sync_cursor)) throw new Error('响应无效')
        cursor = value.sync_cursor
      }
      // 历史、最近页和发送都经同一合并入口，读取找到原发送时也能确认成功。
      // 已建立的历史边界不能被最近页或本地发送覆盖，否则中间旧记录会被跳过。
      const establishHistory = current.current.syncCursor === null
      merge(messages, cursor)
      if (older || establishHistory) update({ ...current.current, before: value.before as string | null, hasOlder: value.has_older })
    } catch (error) {
      if (version !== epoch.current || !enabled.current) return
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
      else update({ ...current.current, ...(older ? { historyNotice: '加载更早消息失败，请重试' } : { notice: '读取失败，请检查网络或访问层后主动重试' }) })
    } finally { if (version === epoch.current) update({ ...current.current, reading: false }) }
  }
  async function send() {
    const state = current.current
    const source = normalizeLabel(label)
    if (!enabled.current || state.attempt || !validText(state.draft) || !validLabel(source)) return
    saveLabel(source)
    const attempt: Attempt = { send_id: crypto.randomUUID(), text: state.draft, source_label: source, state: 'sending' }
    const version = epoch.current
    // 同步写入 ref，双击或连续快捷键即使赶在 React 重绘之前也只能创建一次尝试。
    update({ ...state, attempt, notice: '发送中…' })
    try {
      const value = await request(attempt)
      if (version !== epoch.current || !enabled.current) return
      if (!isMessage(value) || !matches(value, attempt)) throw new Error('响应无效')
      merge([value])
    } catch (error) {
      if (version !== epoch.current || !enabled.current || current.current.attempt?.send_id !== attempt.send_id) return
      // 本票没有重试入口：首次请求的已知前置拒绝可确定本次未执行；409、5xx、外层错误均不能据此换标识。
      const rejected = error instanceof ApiError && (
        (error.status === 400 && ['invalid_json', 'json_required'].includes(error.code)) ||
        (error.status === 413 && ['body_too_large', 'text_too_large'].includes(error.code)) ||
        (error.status === 422 && ['empty_text', 'invalid_send_id', 'invalid_source_label'].includes(error.code)) ||
        (error.status === 403 && error.code === 'origin_rejected') ||
        (error.status === 401 && error.code === 'session_invalid'))
      update({ ...current.current, attempt: rejected ? null : { ...attempt, state: 'unknown' },
        notice: rejected ? `未保存：${error.message}` : unknownNotice })
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
    }
  }
  function saveLabel(value: string) {
    const normalized = normalizeLabel(value)
    if (!validLabel(normalized)) return
    setLabel(normalized)
    try { localStorage.setItem(labelKey, normalized) } catch { update({ ...current.current, notice: '来源标签无法持久保存，仅在当前页面使用' }) }
  }
  function invalidateRead() {
    epoch.current++
    current.current = { ...current.current, reading: false }
  }
  useEffect(() => {
    if (active) void read()
    return invalidateRead
    // 仅在认证状态切换时读取，不增加定时同步或随输入触发读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (current.current.draft || current.current.attempt) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [])
  return { model, label, setLabel, saveLabel, read, send, suspend,
    hasUnsaved: () => Boolean(current.current.draft || current.current.attempt),
    draft: (value: string) => { if (!current.current.attempt) update({ ...current.current, draft: value }) } }
}
