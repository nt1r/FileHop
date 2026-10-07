import { useEffect, useRef, useState } from 'react'

export type Message = { id: string; send_id: string; source_label: string; created_at: string } & (
  { kind: 'TEXT'; text: string } |
  { kind: 'FILE'; file_id: string; file_name: string; file_size: number; file_mime: string; file_state: 'available' | 'storage_error' | 'deleting' | 'deleted'; state_version: string }
)
export type FileStatus = Pick<Extract<Message, { kind: 'FILE' }>, 'file_id' | 'file_state' | 'state_version'>
export function isFileStatus(value: unknown): value is FileStatus {
  if (!value || typeof value !== 'object') return false
  const s = value as FileStatus
  return typeof s.file_id === 'string' && ['available', 'storage_error', 'deleting', 'deleted'].includes(s.file_state) &&
    typeof s.state_version === 'string' && /^[1-9][0-9]*$/.test(s.state_version)
}
export const fileStateLabels = {
  available: '可用', storage_error: '存储异常', deleting: '删除处理中，空间尚未释放', deleted: '服务器文件已删除',
}
type Attempt = { send_id: string; text: string; source_label: string; state: 'sending' | 'unknown' | 'checking'; uncertain?: boolean }
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
export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const m = value as Message
  const common = typeof m.id === 'string' && /^[1-9][0-9]*$/.test(m.id) && typeof m.send_id === 'string' &&
    typeof m.source_label === 'string' && typeof m.created_at === 'string'
  if (!common) return false
  if (m.kind === 'TEXT') return typeof m.text === 'string'
  return m.kind === 'FILE' && typeof m.file_id === 'string' && typeof m.file_name === 'string' &&
    typeof m.file_size === 'number' && Number.isSafeInteger(m.file_size) && m.file_size >= 0 &&
    typeof m.file_mime === 'string' && ['available', 'storage_error', 'deleting', 'deleted'].includes(m.file_state) &&
    typeof m.state_version === 'string' && /^[1-9][0-9]*$/.test(m.state_version)
}
function matches(message: Message, attempt: Attempt) {
  return message.kind === 'TEXT' && message.send_id === attempt.send_id && message.text === attempt.text && message.source_label === attempt.source_label
}
class ApiError extends Error {
  status: number
  code: string
  retryAt: number
  constructor(status: number, code: string, message: string, retryAt = 0) { super(message); this.status = status; this.code = code; this.retryAt = retryAt }
}
async function request(body?: Attempt, path = '/api/messages', fileIds?: string[]) {
  const response = await fetch(path, {
    method: body || fileIds ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    ...(fileIds ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_ids: fileIds }) } : {}),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send_id: body.send_id, text: body.text, source_label: body.source_label }) } : {}),
  })
  const retry = response.headers.get('retry-after')
  const retryAt = retry === null ? 0 : /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0
  if (!response.ok && (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json'))) throw new ApiError(response.status, '', '访问层异常', retryAt)
  if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw new Error('访问层异常')
  let value: unknown
  try { value = await response.json() }
  catch { throw new ApiError(response.status, '', '响应无效', retryAt) }
  if (!response.ok) {
    if (value && typeof value === 'object' && 'code' in value && 'message' in value && typeof value.code === 'string' && typeof value.message === 'string') throw new ApiError(response.status, value.code, value.message, retryAt)
    throw new ApiError(response.status, '', '响应无效', retryAt)
  }
  return value
}

export function useMessages(active: boolean, onExpired: () => void) {
  const [model, setModel] = useState<Model>(empty)
  const current = useRef(model)
  const [label, setLabel] = useState(savedLabel)
  const epoch = useRef(0)
  const knownFiles = useRef(new Map<string, FileStatus>())
  const statusReading = useRef(false)
  const statusAgain = useRef(false)
  const statusRetryAt = useRef(0)
  const [fileStatusNotice, setFileStatusNotice] = useState('')
  function projectFile<T extends Message>(message: T): T {
    const known = message.kind === 'FILE' ? knownFiles.current.get(message.file_id) : undefined
    return known ? { ...message, ...known } : message
  }
  function rememberFiles(statuses: FileStatus[]) {
    for (const status of statuses) {
      const previous = knownFiles.current.get(status.file_id)
      // 同一页面共享最小版本记录；列表、历史、上传回执不能各自恢复旧的可下载状态。
      if (!previous || BigInt(status.state_version) > BigInt(previous.state_version))
        knownFiles.current.set(status.file_id, { file_id: status.file_id, file_state: status.file_state, state_version: status.state_version })
    }
    update({ ...current.current, messages: current.current.messages.map(projectFile) })
  }
  async function refreshFileStates() {
    if (!enabled.current || document.visibilityState !== 'visible') return
    if (Date.now() < statusRetryAt.current) { setFileStatusNotice('文件状态查询暂受限，请稍后刷新。'); return }
    // 下载可能在旧查询途中才发现异常；合并刷新意图，旧查询结束后再取一次，不能漏掉这次发现。
    if (statusReading.current) { statusAgain.current = true; return }
    statusAgain.current = false
    setFileStatusNotice('')
    const version = epoch.current
    const ids = [...knownFiles.current.keys()]
    statusReading.current = true
    try {
      for (let start = 0; start < ids.length; start += 100) {
        if (!enabled.current || version !== epoch.current || document.visibilityState !== 'visible') return
        const batch = ids.slice(start, start + 100)
        const value = await request(undefined, '/api/files/status-query', batch)
        if (!enabled.current || version !== epoch.current) return
        if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files) ||
          !value.files.every(isFileStatus) || !('not_found' in value) || !Array.isArray(value.not_found)) throw Error()
        const returned = [...value.files.map(s => s.file_id), ...value.not_found]
        if (returned.length !== batch.length || new Set(returned).size !== batch.length || returned.some(id => !batch.includes(id))) throw Error()
        rememberFiles(value.files)
      }
    } catch (error) {
      if (!enabled.current || version !== epoch.current) return
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
      else {
        if (error instanceof ApiError) statusRetryAt.current = Math.max(statusRetryAt.current, error.retryAt)
        setFileStatusNotice('文件状态校正失败，请稍后手动刷新。')
      }
    } finally {
      if (version === epoch.current) {
        statusReading.current = false
        if (statusAgain.current) void refreshFileStates()
      }
    }
  }
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryAt = useRef(0)
  const failures = useRef(0)
  const nextPoll = useRef(0)
  function schedule() {
    clearTimeout(pollTimer.current)
    if (!enabled.current || document.visibilityState !== 'visible') return
    // 浏览器定时器有 32 位上限；长 Retry-After 分段等待，避免溢出后变成毫秒级忙循环。
    pollTimer.current = setTimeout(() => void read(), Math.min(2147483647, Math.max(0, nextPoll.current - Date.now(), retryAt.current - Date.now())))
  }
  const enabled = useRef(active)
  enabled.current = active
  const expire = useRef(onExpired)
  expire.current = onExpired
  function update(next: Model) { current.current = next; setModel(next) }
  function suspend(clear: boolean) {
    epoch.current++
    statusReading.current = false
    statusAgain.current = false
    setFileStatusNotice('')
    if (clear) knownFiles.current.clear()
    clearTimeout(pollTimer.current)
    enabled.current = false
    // 到期只隐藏并保留内存载荷；主动退出才丢弃。旧网络回调失去代次后不得恢复内容。
    update(clear ? empty() : { ...current.current, messages: [], syncCursor: null, before: null, hasOlder: false, historyNotice: '', reading: false,
      attempt: current.current.attempt ? { ...current.current.attempt, state: 'unknown', uncertain: true } : null,
      notice: current.current.attempt ? unknownNotice : current.current.notice })
  }
  function merge(messages: Message[], cursor?: string) {
    rememberFiles(messages.filter((m): m is Extract<Message, { kind: 'FILE' }> => m.kind === 'FILE'))
    messages = messages.map(projectFile)
    const state = current.current
    const merged = new Map(state.messages.map(m => [m.id, m]))
    for (const message of messages) {
      const previous = merged.get(message.id)
      // 重复历史或发送回执只补消息，不能用旧版本覆盖已经得知的文件状态。
      merged.set(message.id, previous?.kind === 'FILE' && message.kind === 'FILE' &&
        BigInt(previous.state_version) >= BigInt(message.state_version) ? previous : message)
    }
    const confirmed = state.attempt && messages.some(m => matches(m, state.attempt!))
    update({ ...state, messages: [...merged.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1),
      // 只有完整读取成功才建立快照基线，本地发送响应不能挪动新增读取游标。
      syncCursor: cursor ?? state.syncCursor,
      ...(confirmed ? { draft: '', attempt: null, notice: '发送成功' } : {}) })
  }
  async function read(older = false) {
    if (!enabled.current || document.visibilityState !== 'visible' || current.current.reading) return
    if (Date.now() < retryAt.current) { schedule(); return }
    const boundary = older ? current.current.before : null
    if (older && (!boundary || !current.current.hasOlder)) return
    clearTimeout(pollTimer.current)
    const version = epoch.current
    update({ ...current.current, reading: true, historyNotice: '' })
    try {
      if (!older && current.current.syncCursor !== null) {
        // 每页先完整校验、合并再推进，失败从最后成功页继续；发送和结果查询不能挪动此游标。
        do {
          const cursor = current.current.syncCursor!
          const value = await request(undefined, `/api/messages?after=${cursor}&limit=50`)
          if (version !== epoch.current || !enabled.current) return
          if (!value || typeof value !== 'object' || !('messages' in value) || !Array.isArray(value.messages) || !value.messages.every(isMessage) ||
            !('has_more' in value) || typeof value.has_more !== 'boolean' || !('after' in value)) throw new Error('响应无效')
          const messages = value.messages as Message[]
          if (value.after !== (messages.at(-1)?.id ?? null) || (value.has_more && !messages.length) ||
            messages.some((m, i) => BigInt(m.id) <= BigInt(i ? messages[i - 1].id : cursor))) throw new Error('响应无效')
          merge(messages, messages.at(-1)?.id)
          failures.current = 0
          if (!value.has_more || document.visibilityState !== 'visible') break
        } while (enabled.current)
        update({ ...current.current, notice: current.current.notice.startsWith('读取失败') ? '' : current.current.notice })
        return
      }
      const value = await request(undefined, boundary ? `/api/messages?before=${encodeURIComponent(boundary)}&limit=50` : '/api/messages')
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
      if (!older) {
        failures.current = 0
        update({ ...current.current, notice: current.current.notice.startsWith('读取失败') ? '' : current.current.notice })
      }
    } catch (error) {
      if (version !== epoch.current || !enabled.current) return
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
      else {
        if (error instanceof ApiError) retryAt.current = Math.max(retryAt.current, error.retryAt)
        if (!older) failures.current++
        update({ ...current.current, ...(older ? { historyNotice: '加载更早消息失败，请重试' } : { notice: '读取失败，请检查网络或访问层；将退避重试，也可手动刷新' }) })
      }
    } finally {
      if (version === epoch.current) {
        update({ ...current.current, reading: false })
        // 退避仅针对自动读取，手动/返回前台可提前尝试，但所有入口都必须遵守服务端期限。
        const delay = failures.current ? Math.min(60000, 10000 * 2 ** Math.min(failures.current - 1, 3)) * (0.9 + Math.random() * 0.1) : 10000
        if (!older) nextPoll.current = Date.now() + delay
        schedule()
      }
    }
  }
  async function send() {
    const state = current.current
    const source = normalizeLabel(label)
    if (!enabled.current || state.attempt || !validText(state.draft) || !validLabel(source)) return
    saveLabel(source)
    const attempt: Attempt = { send_id: crypto.randomUUID(), text: state.draft, source_label: source, state: 'sending' }
    await transmit(attempt)
  }
  async function transmit(attempt: Attempt) {
    const version = epoch.current
    // 同步锁定，连续点击也只能发起一次请求；重试始终使用原正文、标签和标识。
    update({ ...current.current, attempt: { ...attempt, state: 'sending' }, notice: '发送中…' })
    try {
      const value = await request(attempt)
      if (version !== epoch.current || !enabled.current) return
      if (!isMessage(value) || !matches(value, attempt)) throw new Error('响应无效')
      merge([value])
    } catch (error) {
      if (version !== epoch.current || !enabled.current || current.current.attempt?.send_id !== attempt.send_id) return
      // 重试被拒绝只说明这一次请求没有执行，不能推翻更早请求可能已经提交的事实。
      const rejected = !attempt.uncertain && error instanceof ApiError && (
        (error.status === 400 && ['invalid_json', 'json_required'].includes(error.code)) ||
        (error.status === 413 && ['body_too_large', 'text_too_large'].includes(error.code)) ||
        (error.status === 422 && ['empty_text', 'invalid_send_id', 'invalid_source_label'].includes(error.code)) ||
        (error.status === 403 && error.code === 'origin_rejected') ||
        (error.status === 401 && error.code === 'session_invalid'))
      update({ ...current.current, attempt: rejected ? null : { ...attempt, state: 'unknown', uncertain: true },
        notice: rejected ? `未保存：${error.message}` : error instanceof ApiError && error.status === 409
          ? '结果未确认：发送标识冲突，请检查历史；不会自动更换标识。' : unknownNotice })
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
    }
  }
  async function retry() {
    const attempt = current.current.attempt
    if (!enabled.current || attempt?.state !== 'unknown') return
    await transmit(attempt)
  }
  async function query() {
    const attempt = current.current.attempt
    if (!enabled.current || attempt?.state !== 'unknown') return
    const version = epoch.current
    update({ ...current.current, attempt: { ...attempt, state: 'checking' }, notice: '正在查询发送结果…' })
    try {
      const value = await request(undefined, `/api/sends/${encodeURIComponent(attempt.send_id)}`)
      if (version !== epoch.current || !enabled.current) return
      if (!isMessage(value) || !matches(value, attempt)) throw new Error('响应无效')
      // 即使用户已放弃确认，成功结果仍可合并；merge 只会清除当前匹配尝试的输入。
      merge([value])
    } catch (error) {
      if (version !== epoch.current || !enabled.current || current.current.attempt?.send_id !== attempt.send_id) return
      update({ ...current.current, attempt: { ...attempt, state: 'unknown' }, notice:
        error instanceof ApiError && error.status === 404 && error.code === 'send_not_found'
          ? '结果未确认：暂未找到；在途请求仍可能保存，可同次重试或放弃确认。' : unknownNotice })
      if (error instanceof ApiError && error.status === 401 && error.code === 'session_invalid') expire.current()
    }
  }
  function abandon() {
    if (!enabled.current || !current.current.attempt?.uncertain) return
    if (!window.confirm('原消息可能已经保存，请先检查历史。放弃确认不是撤回；再次发送可能重复。是否放弃确认？')) return
    // 解除的是本地确认责任，不取消服务器写入；旧回调只能合并消息，不能接管新草稿。
    update({ ...current.current, attempt: null, notice: '已放弃确认，草稿可编辑；原消息可能已保存，再次发送可能重复。' })
  }
  function saveLabel(value: string) {
    const normalized = normalizeLabel(value)
    if (!validLabel(normalized)) return
    setLabel(normalized)
    try { localStorage.setItem(labelKey, normalized) } catch { update({ ...current.current, notice: '来源标签无法持久保存，仅在当前页面使用' }) }
  }
  function invalidateRead() {
    epoch.current++
    statusReading.current = false
    clearTimeout(pollTimer.current)
    current.current = { ...current.current, reading: false }
  }
  useEffect(() => {
    if (active) { failures.current = 0; nextPoll.current = 0; void read().then(refreshFileStates) }
    const visible = () => {
      clearTimeout(pollTimer.current)
      // 让会话层先处理同一次前台事件中的自然到期，避免刚恢复可见就发出已失效的业务请求。
      if (document.visibilityState === 'visible') queueMicrotask(() => { if (enabled.current) void read().then(refreshFileStates) })
    }
    document.addEventListener('visibilitychange', visible)
    return () => { invalidateRead(); document.removeEventListener('visibilitychange', visible) }
    // 调度读取只随认证和可见性变化，不随草稿输入重新计时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (current.current.draft || current.current.attempt) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [])
  return { model, label, setLabel, saveLabel, read, send, retry, query, abandon, suspend,
    rememberFiles, projectFile, refreshFileStates, fileStatusNotice,
    refresh: async () => { await read(); await refreshFileStates() },
    receivedFile: (message: Message) => { if (enabled.current) merge([message]) },
    hasUnsaved: () => Boolean(current.current.draft || current.current.attempt),
    draft: (value: string) => { if (!current.current.attempt) update({ ...current.current, draft: value }) } }
}
