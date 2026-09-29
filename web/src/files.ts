import { useEffect, useRef, useState } from 'react'
import { isMessage, normalizeLabel, validLabel, type Message } from './messages'

// 一次选择固定发送身份且只传一轮。未知不是失败，必须由用户查询或结束整轮后才能解除暂停。
type Task = { mime: string; sendId: string; attemptId: string; source: string; name: string; size: number; progress: number; status: string; pending: boolean; queued: boolean; unresolved: boolean; interrupted: boolean }
type Limits = 'loading' | 'unavailable' | number
const unknown = '结果未确认：服务器可能已保存或仍在处理，请手动查询或结束本轮；重新选择前先检查历史，避免重复。'

export function useFiles(active: boolean, onExpired: () => void, onMessage: (message: Message) => void, refreshFileStates: () => Promise<void>) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [limits, setLimits] = useState<Limits>('loading')
  // 文件实体集中持有，不放进任务快照或异步闭包；到期可立即释放，查询只需要元数据。
  const selectedFiles = useRef(new Map<string, File>())
  const tasksRef = useRef(tasks)
  const limitsRef = useRef(limits)
  const uploadTimeout = useRef(0)
  const live = useRef(active)
  const epoch = useRef(0)
  const xhr = useRef(new Map<string, XMLHttpRequest>())
  const controls = useRef(new Map<string, AbortController>())
  const [online, setOnline] = useState(navigator.onLine)
  live.current = active
  const expired = useRef(onExpired)
  expired.current = onExpired
  const received = useRef(onMessage)
  received.current = onMessage
  function update(next: Task[]) { tasksRef.current = next; setTasks(next) }
  function patch(sendId: string, change: Partial<Task>) {
    update(tasksRef.current.map(task => task.sendId === sendId ? { ...task, ...change } : task))
  }
  function result(sendId: string, status: string, unresolved = false) {
    selectedFiles.current.delete(sendId)
    patch(sendId, { status, pending: false, unresolved })
  }
  function abortRequests() {
    // 先废弃回调，再 abort；同步触发的 onabort 也不能改写下一批任务。
    epoch.current++
    selectedFiles.current.clear()
    for (const upload of xhr.current.values()) upload.abort()
    for (const controller of controls.current.values()) controller.abort()
    xhr.current.clear(); controls.current.clear()
  }
  function reset() {
    abortRequests()
    tasksRef.current = []
    limitsRef.current = 'loading'
  }
  function suspend(clear: boolean) {
    live.current = false
    abortRequests()
    // 到期和退出都只中断本地请求，不向服务器承诺撤回或提前释放预留。
    // 等待项尚未发送，必须重新选择；只留下可能已经保存的身份，供重登后手动查询。
    update(clear ? [] : tasksRef.current.filter(task => task.pending || task.unresolved).map(task =>
      ({ ...task, status: unknown, pending: false, queued: false, unresolved: true, interrupted: true })))
    setLimits('loading'); limitsRef.current = 'loading'
  }
  async function refresh() {
    if (!live.current) return
    const version = epoch.current
    setLimits('loading'); limitsRef.current = 'loading'
    const controller = new AbortController()
    controls.current.get('limits')?.abort()
    controls.current.set('limits', controller)
    const timer = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/transfer-limits', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || version !== epoch.current || !live.current) return
      if (response.status === 401 && !response.headers.has('x-filehop-access-layer')) {
        const error = await response.json()
        if (controller.signal.aborted || version !== epoch.current || !live.current) return
        if (error.code === 'session_invalid') { expired.current(); return }
      }
      if (!response.ok || response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw Error()
      const data: unknown = await response.json()
      if (controller.signal.aborted || version !== epoch.current || !live.current) return
      if (!data || typeof data !== 'object' || !('max_file_size_bytes' in data) ||
        typeof data.max_file_size_bytes !== 'number' || !Number.isSafeInteger(data.max_file_size_bytes) || data.max_file_size_bytes < 0 ||
        !('upload_total_timeout_seconds' in data) || typeof data.upload_total_timeout_seconds !== 'number' ||
        !Number.isSafeInteger(data.upload_total_timeout_seconds) || data.upload_total_timeout_seconds < 1 ||
        data.upload_total_timeout_seconds > 4294907) throw Error()
      // XHR 的毫秒期限是 uint32；额外一分钟只用于等待提交响应，不代表成功或回滚。
      uploadTimeout.current = (data.upload_total_timeout_seconds + 60) * 1000
      limitsRef.current = data.max_file_size_bytes
      setLimits(data.max_file_size_bytes)
    } catch {
      if (controls.current.get('limits') === controller && version === epoch.current && live.current) {
        limitsRef.current = 'unavailable'; setLimits('unavailable')
      }
    } finally { window.clearTimeout(timer); if (controls.current.get('limits') === controller) controls.current.delete('limits') }
  }
  useEffect(() => {
    if (active) void refresh()
    // 新会话必须重新取得有效限制；但恢复限制不查询或重传未确认任务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (tasksRef.current.some(task => task.queued || task.pending || task.unresolved)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  function pump() {
    if (!live.current || !navigator.onLine || document.visibilityState !== 'visible' ||
      typeof limitsRef.current !== 'number' || tasksRef.current.some(task => task.pending || task.unresolved)) return
    const task = tasksRef.current.find(task => task.queued)
    if (!task) return
    // 在发出准备前同步占用唯一页面名额；等待项不向服务器预留空间。
    patch(task.sendId, { queued: false, pending: true, status: '准备上传…' })
    if (task.size > limitsRef.current) { result(task.sendId, '文件超过服务器单文件上限'); return }
    void prepare(task)
  }
  useEffect(() => { pump() }, [tasks, limits, active, online])
  useEffect(() => {
    const resume = () => { setOnline(navigator.onLine); pump() }
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])
  function choose(files: File[], label: string) {
    if (!live.current || typeof limitsRef.current !== 'number' || !validLabel(label) || !navigator.onLine) return
    const source = normalizeLabel(label)
    const maximum = limitsRef.current
    const added: Task[] = files.map(file => {
      const invalid = file.size > maximum ? '文件超过服务器单文件上限' :
        new TextEncoder().encode(file.name).length > 1024 || !file.name || file.name.includes('\0') || file.type.length > 255 ? '文件元数据不符合服务器要求' : ''
      const sendId = crypto.randomUUID()
      if (!invalid) selectedFiles.current.set(sendId, file)
      return { mime: file.type, sendId, attemptId: crypto.randomUUID(), source, name: file.name,
        size: file.size, progress: 0, status: invalid || '等待上传', pending: false, queued: !invalid, unresolved: false, interrupted: false }
    })
    // 选择后仍刷新准入限制，但不让等待这个请求的闭包持有整批 File。
    // loading 会暂停调度；真正开始发送时再按最新限制检查大小。
    void refresh()
    update([...tasksRef.current, ...added])
  }
  function remove(sendId: string) {
    if (!tasksRef.current.some(task => task.sendId === sendId && task.queued)) return
    selectedFiles.current.delete(sendId)
    update(tasksRef.current.filter(task => task.sendId !== sendId))
  }
  function current(task: Task, version: number) {
    const existing = tasksRef.current.find(item => item.sendId === task.sendId)
    return version === epoch.current && live.current && Boolean(existing && !existing.interrupted)
  }
  async function prepare(task: Task) {
    const version = epoch.current
    const controller = new AbortController()
    controls.current.set(task.sendId, controller)
    const timer = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/file-sends', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ send_id: task.sendId, attempt_id: task.attemptId, name: task.name, size: task.size, mime: task.mime, source_label: task.source }) })
      if (!current(task, version)) return
      if (!response.headers.get('content-type')?.includes('application/json') || response.headers.has('x-filehop-access-layer')) throw Error()
      const value = await response.json()
      if (!current(task, version)) return
      if (!response.ok) {
        if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
        // 新身份只发过一次准备；明确准入拒绝可结束本项，冲突或服务故障则保留未知。
        const rejected = (response.status >= 400 && response.status < 500 && response.status !== 409 ||
          value.code === 'quota_exceeded' || value.code === 'disk_full') && typeof value.code === 'string' && typeof value.message === 'string'
        result(task.sendId, !rejected ? unknown : value.code === 'quota_exceeded' ? '文件空间不足，请重新选择发送' :
          value.code === 'disk_full' ? '磁盘空间不足，请重新选择发送' : `上传被拒绝：${value.message}；再发请重新选择`, !rejected)
        return
      }
      if (value.state !== 'prepared' || value.send_id !== task.sendId || value.attempt_id !== task.attemptId) throw Error()
      transmit(task, version)
    } catch { if (current(task, version)) result(task.sendId, unknown, true) }
    finally { window.clearTimeout(timer); if (controls.current.get(task.sendId) === controller) controls.current.delete(task.sendId) }
  }
  function transmit(task: Task, version: number) {
    patch(task.sendId, { status: '正在传输…', pending: true, progress: 0 })
    const upload = new XMLHttpRequest()
    xhr.current.set(task.sendId, upload)
    upload.open('PUT', `/api/file-sends/${task.sendId}/attempts/${task.attemptId}/content`)
    upload.responseType = 'json'
    upload.setRequestHeader('Content-Type', 'application/octet-stream')
    upload.timeout = uploadTimeout.current
    upload.upload.onprogress = event => {
      if (!current(task, version)) return
      patch(task.sendId, { progress: event.total ? Math.min(100, Math.round(event.loaded / event.total * 100)) : 0,
        status: event.lengthComputable && event.loaded >= event.total ? '数据已发送，等待服务器确认…' : '正在传输…' })
    }
    upload.onload = () => {
      if (xhr.current.get(task.sendId) === upload) xhr.current.delete(task.sendId)
      if (!current(task, version)) return
      const value = upload.response
      if (upload.status === 200 && matches(task, value)) {
        success(task, value)
      } else if (upload.status >= 400 && value?.code && upload.getResponseHeader('content-type')?.includes('application/json') && !upload.getResponseHeader('x-filehop-access-layer')) {
        if (upload.status === 401 && value.code === 'session_invalid') { expired.current(); return }
        // 清理中已确定不会提交，可以继续下一项；实体未清理仍由服务器计费。
        if (value.code === 'upload_failed') result(task.sendId, `上传失败：${value.message}；再发请重新选择`)
        else if (value.code === 'cleanup_pending') result(task.sendId, '上传失败，清理未完成，空间尚未释放；再发请重新选择。')
        else result(task.sendId, unknown, true)
      } else result(task.sendId, unknown, true)
    }
    upload.onerror = upload.ontimeout = upload.onabort = () => {
      if (xhr.current.get(task.sendId) === upload) xhr.current.delete(task.sendId)
      if (current(task, version)) result(task.sendId, unknown, true)
    }
    upload.send(selectedFiles.current.get(task.sendId))
    selectedFiles.current.delete(task.sendId)
  }
  function matches(task: Task, value: unknown): value is Message {
    return isMessage(value) && value.kind === 'FILE' && value.send_id === task.sendId &&
      value.file_name === task.name && value.file_size === task.size && value.source_label === task.source
  }
  function success(task: Task, message: Message) {
    patch(task.sendId, { status: '上传成功', progress: 100, pending: false, unresolved: false })
    received.current(message)
  }
  async function query(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (!live.current || !task || !task.unresolved || task.pending) return
    const version = epoch.current
    patch(sendId, { status: '正在查询发送结果…', pending: true })
    const controller = new AbortController()
    controls.current.set(sendId, controller)
    const timer = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`/api/file-sends/${sendId}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (version !== epoch.current || !live.current) return
      if (response.headers.has('x-filehop-access-layer')) throw Error()
      const value = await response.json()
      if (version !== epoch.current || !live.current) return
      if (response.status === 401 && value.code === 'session_invalid') { expired.current(); return }
      // 404 也不能证明在途准备未发生；查询永不创建身份或重放准备/内容请求。
      if (!response.ok || value.send_id !== sendId) throw Error()
      if (value.state === 'success' && matches(task, value.message)) { success(task, value.message); return }
      if (value.attempt_id !== task.attemptId) throw Error()
      if (value.state === 'failed' || value.state === 'stopped') result(sendId, '上传失败，发送已终结；再发请重新选择。')
      else if (value.state === 'cleaning') result(sendId, '上传失败，清理未完成，空间尚未释放；再发请重新选择。')
      else result(sendId, unknown, true)
    } catch { if (version === epoch.current && live.current) result(sendId, unknown, true) }
    finally { window.clearTimeout(timer); if (controls.current.get(sendId) === controller) controls.current.delete(sendId) }
  }
  function interrupt(sendId: string) {
    const task = tasksRef.current.find(item => item.sendId === sendId)
    if (!live.current || !task?.pending || task.unresolved) return
    // 标记先于 abort，防止迟到准备继续发送文件体；中断不能把可能成功的结果改成失败。
    selectedFiles.current.delete(sendId)
    patch(sendId, { interrupted: true, pending: false, unresolved: true, status: unknown })
    xhr.current.get(sendId)?.abort()
    controls.current.get(sendId)?.abort()
  }
  function endBatch() {
    if (!live.current || !window.confirm('结束本轮只清空客户端队列，不撤回服务器任务。文件可能已经或随后保存；重新选择前请检查历史，重选可能重复。确认结束本轮？')) return
    abortRequests()
    update([])
    // 结束时若限制查询也在途，则重新取得能力；这不是协调已丢弃的发送。
    if (limitsRef.current === 'loading') void refresh()
  }
  async function download(fileId: string): Promise<string> {
    const version = epoch.current
    try {
      // HEAD 只检查可识别的鉴权与实体拒绝；GET 由浏览器流式保存，不承诺获知落盘结果。
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
        method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      if (version !== epoch.current || !live.current) return ''
      if (!response.ok || response.headers.has('x-filehop-access-layer')) {
        if (response.status === 401 && !response.headers.has('x-filehop-access-layer')) expired.current()
        else await refreshFileStates()
        if (version !== epoch.current || !live.current) return ''
        return '无法开始下载：文件不可用或登录/访问层异常，请检查后重试。'
      }
      const link = document.createElement('a')
      link.href = `/api/files/${encodeURIComponent(fileId)}`
      link.click()
      return ''
    } catch { return version === epoch.current && live.current ? '无法确认下载请求，请检查网络后重试。' : '' }
  }
  return { tasks, limits, refresh, choose, remove, query, interrupt, endBatch, download, suspend, reset,
    paused: !online || tasks.some(task => task.unresolved),
    hasUnsaved: () => tasksRef.current.some(task => task.queued || task.pending || task.unresolved) }
}
