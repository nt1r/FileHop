import { useEffect, useRef, useState } from 'react'
import { isMessage, normalizeLabel, validLabel, type Message } from './messages'

// queued 尚未申请额度；pending 是本页请求在途；unresolved 表示尚不能确认服务端状态，须暂停新上传。
// 已查询到仍活动的任务继续占名额，但不再以网络未知为由阻塞其他空闲名额。
type Task = { file: File; sendId: string; attemptId: string; previousAttemptId?: string; source: string; name: string; size: number; progress: number; status: string; pending: boolean; queued?: boolean; unresolved?: boolean; stopping?: boolean; stopRequested?: boolean; abandoned?: boolean }
type Limits = 'loading' | 'unavailable' | number
const unknown = '结果未确认：请先检查消息历史；本页不会自动重发或更换发送标识。'
const pendingCleanup = '结果未确认：清理未完成，空间尚未释放；请先检查消息历史。'
const uncertain = (task: Task) => task.status.startsWith('结果未确认：')

export function useFiles(active: boolean, onExpired: () => void, onMessage: (message: Message) => void) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [limits, setLimits] = useState<Limits>('loading')
  const tasksRef = useRef(tasks)
  const limitsRef = useRef(limits)
  const live = useRef(active)
  const epoch = useRef(0)
  const xhr = useRef(new Map<string, XMLHttpRequest>())
  const controls = useRef(new Map<string, AbortController>())
  const [online, setOnline] = useState(navigator.onLine)
  const preparingQueue = useRef<AbortController | null>(null)
  live.current = active
  const expired = useRef(onExpired)
  expired.current = onExpired
  const received = useRef(onMessage)
  received.current = onMessage
  function update(next: Task[]) { tasksRef.current = next; setTasks(next) }
  function patch(sendId: string, change: Partial<Task>) {
    update(tasksRef.current.map(task => task.sendId === sendId ? { ...task,
      ...(change.status && !change.pending ? { unresolved: change.status.startsWith('结果未确认：') } : {}), ...change } : task))
  }
  function reset() {
    epoch.current++
    for (const upload of xhr.current.values()) upload.abort()
    for (const controller of controls.current.values()) controller.abort()
    xhr.current.clear(); controls.current.clear()
    tasksRef.current = []
    preparingQueue.current = null
    limitsRef.current = 'loading'
  }
  function suspend(clear: boolean) {
    live.current = false
    epoch.current++
    // 到期不能截断已经认证的 PUT；退出时才中止本页上传。服务器负责最终裁决及超时清理。
    if (clear) {
      // 退出先发出按尝试的尽力停止；即使响应丢失，服务端超时仍会回收未提交实体。
      for (const task of tasksRef.current.filter(task => task.pending || uncertain(task) || task.stopping)) {
        void fetch(`/api/file-sends/${task.sendId}/attempts/${task.attemptId}/stop`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        }).catch(() => {})
      }
      for (const upload of xhr.current.values()) upload.abort()
      xhr.current.clear()
    }
    for (const controller of controls.current.values()) controller.abort()
    controls.current.clear()
    preparingQueue.current = null
    if (clear) update([])
    // 原来已查到“仍活动”的任务也必须在新会话重新协调，不能沿用旧的可调度判断。
    else update(tasksRef.current.map(task => task.pending || uncertain(task) ? { ...task, status: unknown, pending: false, unresolved: true, stopping: false } : task))
    setLimits('loading'); limitsRef.current = 'loading'
  }
  async function refresh() {
    if (!live.current) return
    const version = epoch.current
    setLimits('loading'); limitsRef.current = 'loading'
    const controller = new AbortController()
    controls.current.set('limits', controller)
    const timer = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/transfer-limits', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (version !== epoch.current || !live.current) return
      if (response.status === 401 && !response.headers.has('x-filehop-access-layer')) {
        const error = await response.json()
        if (version !== epoch.current || !live.current) return
        if (error.code === 'session_invalid') { expired.current(); return }
      }
      if (!response.ok || response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw Error()
      const data: unknown = await response.json()
      if (version !== epoch.current || !live.current) return
      if (!data || typeof data !== 'object' || !('max_file_size_bytes' in data) ||
        typeof data.max_file_size_bytes !== 'number' || !Number.isSafeInteger(data.max_file_size_bytes) || data.max_file_size_bytes < 0) throw Error()
      limitsRef.current = data.max_file_size_bytes
      setLimits(data.max_file_size_bytes)
      // 新登录先取得当前能力，再查询原发送身份；全部未知项协调前仍由 unresolved 挡住等待项。
      // 重查限制成功也走这条路径，避免一次网络失败让恢复永久停住；查询不会自动重传失败项。
      for (const task of tasksRef.current.filter(task => uncertain(task) && !task.pending)) void inspect(task, false)
    } catch { if (version === epoch.current && live.current) { limitsRef.current = 'unavailable'; setLimits('unavailable') } }
    finally { window.clearTimeout(timer); if (controls.current.get('limits') === controller) controls.current.delete('limits') }
  }
  useEffect(() => {
    if (active) void refresh()
    // 新会话必须重新取得有效限制；旧快照不是服务器的准入保证。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (tasksRef.current.some(task => task.queued || task.pending || uncertain(task))) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      for (const task of tasksRef.current.filter(task => uncertain(task) && !task.pending)) void inspect(task, false)
    }, 10000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  // 名额在准备请求前同步占用；等待项只在内存中，不能提前向服务器预留额度。
  function pump() {
    if (!live.current || !navigator.onLine || document.visibilityState !== 'visible' ||
      preparingQueue.current || typeof limitsRef.current !== 'number' || tasksRef.current.some(task => task.unresolved)) return
    if (tasksRef.current.filter(task => task.pending || uncertain(task)).length >= 3) return
    const task = tasksRef.current.find(task => task.queued)
    if (!task) return
    patch(task.sendId, { queued: false, pending: true, status: '准备上传…' })
    // 准入持有短时全局锁；本页依次申请，获准后文件体仍可三个并行，避免自己触发背压拒绝。
    void prepare(task)
  }
  useEffect(() => { pump() }, [tasks, limits, active, online])
  useEffect(() => {
    const resume = () => {
      setOnline(navigator.onLine)
      if (!live.current || !navigator.onLine || document.visibilityState !== 'visible') return
      // 查询期间仍保留未知标记，最后一项确认后才接续等待项。
      for (const task of tasksRef.current.filter(task => uncertain(task) && !task.pending)) void inspect(task, false)
      pump()
    }
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])
  async function choose(files: File[], label: string) {
    if (!live.current || typeof limitsRef.current !== 'number' || !validLabel(label) || !navigator.onLine) return
    // 文件选择前的快照只供展示；选择后再取一次有效上限，无法确认时不猜测准入能力。
    const selectionVersion = epoch.current
    await refresh()
    if (selectionVersion !== epoch.current || !live.current || !navigator.onLine || typeof limitsRef.current !== 'number') return
    const source = normalizeLabel(label)
    const maximum = limitsRef.current
    const added: Task[] = files.map(file => {
      const invalid = file.size > maximum ? '文件超过服务器单文件上限' :
        new TextEncoder().encode(file.name).length > 1024 || !file.name || file.name.includes('\0') || file.type.length > 255 ? '文件元数据不符合服务器要求' : ''
      return { file, sendId: crypto.randomUUID(), attemptId: crypto.randomUUID(), source, name: file.name,
        size: file.size, progress: 0, status: invalid || '等待上传', pending: false, queued: !invalid }
    })
    update([...tasksRef.current, ...added])
  }
  function remove(sendId: string) {
    update(tasksRef.current.filter(task => task.sendId !== sendId || !task.queued))
  }
  async function prepare(task: Task) {
    const { file, source } = task
    const version = epoch.current
    const preparing = new AbortController()
    preparingQueue.current = preparing
    controls.current.set(task.sendId, preparing)
    const timer = window.setTimeout(() => preparing.abort(), 15000)
    try {
      const response = await fetch('/api/file-sends', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: preparing.signal,
        body: JSON.stringify({ send_id: task.sendId, attempt_id: task.attemptId, name: file.name, size: file.size, mime: file.type, source_label: source }) })
      if (version !== epoch.current || !live.current) return
      if (!response.headers.get('content-type')?.includes('application/json') || response.headers.has('x-filehop-access-layer')) throw Error()
      const value = await response.json()
      if (version !== epoch.current || !live.current || tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) return
      if (!response.ok) {
        if (response.status === 401 && value.code === 'session_invalid') {
          patch(task.sendId, { status: unknown, pending: false }); expired.current(); return
        }
        // 只有明确的准入拒绝能判定未上传；5xx、冲突和非法格式可能掩盖已获预留的准备结果。
        const rejected = response.status >= 400 && response.status < 500 && response.status !== 409 &&
          typeof value.code === 'string' && typeof value.message === 'string'
        patch(task.sendId, { status: !rejected ? unknown : value.code === 'quota_exceeded' ? '文件空间不足' :
          value.code === 'disk_full' ? '磁盘空间不足' : `上传被拒绝：${value.message}`, pending: false })
        return
      }
      if (tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) return
      if (value.state !== 'prepared' || value.send_id !== task.sendId || value.attempt_id !== task.attemptId) throw Error()
      transmit(task, version)
    } catch {
      if (version === epoch.current && live.current && !tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested)
        patch(task.sendId, { status: unknown, pending: false })
    } finally {
      window.clearTimeout(timer)
      if (controls.current.get(task.sendId) === preparing) controls.current.delete(task.sendId)
      // 旧认证周期的 finally 不能解开新请求持有的准入锁。
      if (preparingQueue.current === preparing) preparingQueue.current = null
      pump()
    }
  }
  function transmit(task: Task, version: number) {
      const { file, source } = task
      patch(task.sendId, { status: '正在传输…', pending: true, progress: 0 })
      const upload = new XMLHttpRequest()
      xhr.current.set(task.sendId, upload)
      upload.open('PUT', `/api/file-sends/${task.sendId}/attempts/${task.attemptId}/content`)
      upload.responseType = 'json'
      upload.setRequestHeader('Content-Type', 'application/octet-stream')
      // 浏览器会发送同源 Cookie 与 Origin；不能将控制请求的 15 秒期限用于文件体。
      upload.timeout = 31 * 60 * 1000
      upload.upload.onprogress = event => {
        if (version !== epoch.current || !live.current || tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) return
        patch(task.sendId, { progress: event.total ? Math.min(100, Math.round(event.loaded / event.total * 100)) : 0,
          status: event.lengthComputable && event.loaded >= event.total ? '数据已发送，等待服务器确认…' : '正在传输…' })
      }
      upload.onload = () => {
        if (xhr.current.get(task.sendId) === upload) xhr.current.delete(task.sendId)
        if (version !== epoch.current || !live.current || tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) return
        const value = upload.response
        if (upload.status === 200 && isMessage(value) && value.kind === 'FILE' && value.send_id === task.sendId &&
          value.file_name === task.name && value.file_size === task.size && value.source_label === source) {
          patch(task.sendId, { progress: 100, status: '上传成功', pending: false })
          received.current(value as Message)
        } else if (upload.status >= 400 && value?.code && upload.getResponseHeader('content-type')?.includes('application/json')) {
          if (upload.status === 401 && value.code === 'session_invalid') {
            patch(task.sendId, { status: unknown, pending: false }); expired.current(); return
          }
          // 失败清理完成才能明确断言未提交；清理待定和服务器故障均保留未确认状态。
          patch(task.sendId, { status: value.code === 'upload_failed' ? `上传失败：${value.message}` :
            value.code === 'cleanup_pending' ? '上传失败，清理未完成，空间尚未释放；可稍后查询。' : unknown, pending: false })
        } else patch(task.sendId, { status: unknown, pending: false })
      }
      upload.onerror = upload.ontimeout = upload.onabort = () => {
        if (xhr.current.get(task.sendId) === upload) xhr.current.delete(task.sendId)
        if (version === epoch.current && live.current && !tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested)
          patch(task.sendId, { status: unknown, pending: false })
      }
      upload.send(file)
  }
  // 未收到响应时先查发送身份；只有服务器确认失败且旧实体清理完成，才允许从头重传。
  async function inspect(task: Task, retry: boolean) {
    if (!live.current || typeof limitsRef.current !== 'number' || task.queued || task.pending || task.stopping || (retry && task.abandoned)) return
    if (retry && (!navigator.onLine || typeof limitsRef.current !== 'number' ||
      tasksRef.current.some(item => item.sendId !== task.sendId && item.unresolved))) return
    if (!uncertain(task) && tasksRef.current.filter(item => item.pending || uncertain(item)).length >= 3) return
    const version = epoch.current
    patch(task.sendId, { status: '正在查询发送结果…', pending: true, unresolved: uncertain(task) || task.unresolved })
    const controller = new AbortController()
    controls.current.set(task.sendId, controller)
    const timer = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`/api/file-sends/${task.sendId}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || version !== epoch.current || !live.current || tasksRef.current.find(item => item.sendId === task.sendId)?.stopping) return
      if (response.headers.has('x-filehop-access-layer')) throw Error()
      const value = await response.json()
      if (controller.signal.aborted || version !== epoch.current || !live.current || tasksRef.current.find(item => item.sendId === task.sendId)?.stopping) return
      if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
      if (response.status === 404 && retry && !task.previousAttemptId && !task.stopRequested) {
        await replayFirst(task, version, controller)
        return
      }
      if (!response.ok || value.send_id !== task.sendId) throw Error()
      if (value.state === 'stopped' && value.attempt_id === task.attemptId) {
        if (retry && !task.stopRequested) {
          const next = crypto.randomUUID()
          patch(task.sendId, { attemptId: next, previousAttemptId: task.attemptId })
          await startSuccessor({ ...task, attemptId: next }, task.attemptId, version, controller)
        } else patch(task.sendId, { status: '已停止；如有残留，清理完成前仍占额度。', pending: false, stopRequested: false })
        return
      }
      if (value.state === 'success' && isMessage(value.message) && value.message.kind === 'FILE' &&
        value.message.send_id === task.sendId && value.message.file_name === task.name &&
        value.message.file_size === task.size && value.message.source_label === task.source) {
        patch(task.sendId, { status: '上传成功', progress: 100, pending: false, stopRequested: false })
        received.current(value.message)
        return
      }
      if (value.attempt_id !== task.attemptId) {
        if (task.previousAttemptId && value.attempt_id === task.previousAttemptId) {
          if (value.state === 'failed' && retry && !task.stopRequested) await startSuccessor(task, task.previousAttemptId, version, controller)
          else patch(task.sendId, { status: value.state === 'cleaning' ? pendingCleanup : unknown, pending: false })
          return
        }
        throw Error()
      }
      if (retry && !task.stopRequested && task.previousAttemptId && value.state === 'prepared') {
        await startSuccessor(task, task.previousAttemptId, version, controller)
        return
      }
      if (value.state === 'prepared' && retry && !task.previousAttemptId && !task.stopRequested) {
        await replayFirst(task, version, controller)
        return
      }
      if (value.state === 'cleaning' && value.stop_requested === true) {
        patch(task.sendId, { status: '已停止；如有残留，清理完成前仍占额度。', pending: false, stopRequested: false }); return
      }
      if (value.state === 'cleaning') {
        // 服务端已裁决不提交，因此释放页面名额；残留仍占服务器额度，重试仍须先查询清理结果。
        patch(task.sendId, { status: '上传失败，清理未完成，空间尚未释放；可稍后查询。', pending: false })
        return
      }
      if (value.state !== 'failed') {
        if (value.state !== 'prepared' && value.state !== 'writing') throw Error()
        // 已确认仍活动只占一个名额，不再阻塞其他空闲名额；查询失败才重新暂停整条队列。
        patch(task.sendId, { status: '结果未确认：服务器仍在接收或处理；请稍后查询，不会启动第二次写入。', pending: false, unresolved: false })
        return
      }
      if (!retry || task.stopRequested) {
        patch(task.sendId, { status: '上传失败，服务器已清理；可明确重试。', pending: false, stopRequested: false }); return
      }
      const next = crypto.randomUUID()
      // 在发送准备之前保留后继身份：超时后再次点击会重放同一请求，而不是创建第三次尝试。
      patch(task.sendId, { attemptId: next, previousAttemptId: task.attemptId })
      await startSuccessor({ ...task, attemptId: next }, task.attemptId, version, controller)
    } catch { if (version === epoch.current && live.current && !tasksRef.current.find(item => item.sendId === task.sendId)?.stopping) patch(task.sendId, { status: unknown, pending: false }) }
    finally { window.clearTimeout(timer); if (controls.current.get(task.sendId) === controller) controls.current.delete(task.sendId) }
  }
  async function replayFirst(task: Task, version: number, controller: AbortController) {
    // 准备响应丢失后仍重放最初的尝试身份；服务器已有准备就继续上传，不创建后继。
    const response = await fetch('/api/file-sends', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ send_id: task.sendId, attempt_id: task.attemptId, name: task.name,
        size: task.size, mime: task.file.type, source_label: task.source }) })
    if (version !== epoch.current || !live.current) return
    if (response.headers.has('x-filehop-access-layer')) throw Error()
    const value = await response.json()
    if (version !== epoch.current || !live.current) return
    if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
    if (response.ok && value.state === 'prepared' && value.attempt_id === task.attemptId && value.send_id === task.sendId &&
      !tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) {
      transmit(task, version); return
    }
    throw Error()
  }
  async function startSuccessor(task: Task, previous: string, version: number, controller: AbortController) {
    const response = await fetch(`/api/file-sends/${task.sendId}/attempts`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ attempt_id: task.attemptId, previous_attempt_id: previous,
        name: task.name, size: task.size, mime: task.file.type, source_label: task.source }) })
    if (version !== epoch.current || !live.current) return
    if (response.headers.has('x-filehop-access-layer')) throw Error()
    const value = await response.json()
    if (version !== epoch.current || !live.current) return
    if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
    if (response.ok && isMessage(value) && value.kind === 'FILE' && value.send_id === task.sendId) {
      patch(task.sendId, { status: '上传成功', progress: 100, pending: false, stopRequested: false }); received.current(value); return
    }
    if (response.ok && value.state === 'prepared' && value.attempt_id === task.attemptId && value.send_id === task.sendId &&
      !tasksRef.current.find(item => item.sendId === task.sendId)?.stopRequested) {
      transmit(task, version); return
    }
    if (response.ok && value.state === 'stopped' && value.attempt_id === task.attemptId) {
      patch(task.sendId, { status: '已停止；如有残留，清理完成前仍占额度。', pending: false }); return
    }
    if (response.status === 409 && value.code === 'attempt_busy') {
      patch(task.sendId, { status: pendingCleanup, pending: false }); return
    }
    throw Error()
  }
  async function query(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (task) await inspect(task, false)
  }
  async function retry(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (task) await inspect(task, true)
  }
  // abort 仅停止本页发数据；服务端停止与成功由独立的持久裁决决定。
  async function stop(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (!live.current || !task || (!task.pending && !uncertain(task)) || task.queued || task.stopping || task.status === '上传成功' ||
      task.status.startsWith('已停止') || task.status.startsWith('上传失败') || task.status.startsWith('上传被拒绝') || task.status.startsWith('文件超过') || task.status.startsWith('文件元数据')) return
    patch(sendId, { stopping: true, stopRequested: true, pending: true, status: '正在请求停止…' })
    xhr.current.get(sendId)?.abort()
    controls.current.get(sendId)?.abort()
    const version = epoch.current
    try {
      const response = await fetch(`/api/file-sends/${sendId}/attempts/${task.attemptId}/stop`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      if (version !== epoch.current || !live.current) return
      if (response.headers.has('x-filehop-access-layer')) throw Error()
      const value = await response.json()
      if (version !== epoch.current || !live.current) return
      if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
      if (!response.ok) throw Error()
      if (isMessage(value) && value.kind === 'FILE' && value.send_id === sendId) {
        patch(sendId, { status: '上传成功', pending: false, stopping: false, stopRequested: false, progress: 100 })
        received.current(value); return
      }
      if (value.state !== 'stopped' || value.send_id !== sendId || value.attempt_id !== task.attemptId) throw Error()
      patch(sendId, { status: '已停止；如有残留，清理完成前仍占额度。', pending: false, stopping: false, stopRequested: false })
    } catch {
      if (version === epoch.current && live.current) patch(sendId, { status: unknown, pending: false, stopping: false })
    }
  }
  function abandon(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (!task || !uncertain(task) || task.pending || !window.confirm('放弃确认不等于撤回。服务器可能仍在接收或已保存文件；本页会继续协调，不会自动重发。确认放弃？')) return
    // 保留最小协调记录；未确认项仍占页面名额，不能靠反复放弃绕开暂停规则。
    patch(sendId, { abandoned: true })
  }
  async function download(fileId: string): Promise<string> {
    const version = epoch.current
    try {
      // HEAD 只检查可识别的鉴权与实体拒绝；GET 由浏览器直接流式保存，不承诺页面能获知落盘结果。
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
        method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      if (version !== epoch.current || !live.current) return ''
      if (!response.ok || response.headers.has('x-filehop-access-layer')) {
        if (response.status === 401 && !response.headers.has('x-filehop-access-layer')) expired.current()
        return '无法开始下载：文件不可用或登录/访问层异常，请检查后重试。'
      }
      const link = document.createElement('a')
      link.href = `/api/files/${encodeURIComponent(fileId)}`
      link.click()
      return ''
    } catch {
      return version === epoch.current && live.current ? '无法确认下载请求，请检查网络后重试。' : ''
    }
  }
  return { tasks, limits, refresh, choose, remove, query, retry, stop, abandon, download, suspend, reset,
    paused: !online || tasks.some(task => task.unresolved),
    waiting: tasks.filter(task => task.abandoned && (task.pending || uncertain(task))).length,
    hasUnsaved: () => tasksRef.current.some(task => task.queued || task.pending || uncertain(task)) }
}
