import { useEffect, useRef, useState } from 'react'
import { isFileStatus, type Message, type useMessages } from './messages'

type FileMessage = Extract<Message, { kind: 'FILE' }>
type Operation = { phase: 'requesting' | 'unknown' | 'accepted' | 'rejected'; notice: string; next: number; retryAt: number; failures: number; busy: boolean }
const unknown = '删除结果未确认：正在查询；原请求仍可能执行。重试不等于取消原请求。'

export function useDeletion(active: boolean, exchange: ReturnType<typeof useMessages>, onExpired: () => void) {
  const operations = useRef(new Map<string, Operation>())
  const [, render] = useState(0)
  const [usageRevision, setUsageRevision] = useState(0)
  const live = useRef(active)
  live.current = active
  const epoch = useRef(0)
  const callbacks = useRef({ exchange, onExpired })
  callbacks.current = { exchange, onExpired }
  function changed() { render(n => n + 1) }
  function suspend(clear: boolean) {
    live.current = false
    epoch.current++
    if (clear) operations.current.clear()
    else for (const operation of operations.current.values()) {
      if (operation.phase === 'requesting') { operation.phase = 'unknown'; operation.notice = unknown }
      operation.busy = false
    }
    changed()
  }
  async function perform(id: string, deleting: boolean) {
    const operation = operations.current.get(id)
    if (!live.current || !operation || operation.busy) return
    operation.busy = true
    const version = epoch.current
    let retryAt = 0
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(id)}${deleting ? '' : '/status'}`, {
        method: deleting ? 'DELETE' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      const retry = response.headers.get('retry-after')
      if (retry) retryAt = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0
      if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw Error()
      const value = await response.json()
      if (!live.current || version !== epoch.current || operations.current.get(id) !== operation) return
      if (response.status === 401 && value?.code === 'session_invalid') { callbacks.current.onExpired(); return }
      // FILE_IN_USE 是本次明确拒绝，不排队等待下载结束；之后只能由用户再次确认。
      if (deleting && response.status === 409 && value?.code === 'FILE_IN_USE') {
        operation.phase = 'rejected'
        operation.notice = '文件正在下载，本次删除已结束；下载结束后请再次确认删除。'
        return
      }
      if (!response.ok || !isFileStatus(value) || value.file_id !== id ||
        (deleting && value.file_state !== 'deleting' && value.file_state !== 'deleted')) throw Error()
      callbacks.current.exchange.rememberFiles([value])
      // 在途单文件查询可能比列表/历史校正更旧；流程也服从已合并的版本，不能被旧 available 拖回未知。
      const state = callbacks.current.exchange.fileStatus(id) ?? value
      operation.failures = 0
      if (state.file_state === 'deleting' || state.file_state === 'deleted') {
        operation.phase = 'accepted'
        operation.notice = ''
        // 容量独立重新查询，不能拿文件大小作乐观扣减；面板自行阻挡旧快照。
        setUsageRevision(n => n + 1)
        if (state.file_state === 'deleted') { operations.current.delete(id); changed() }
      } else if (operation.phase !== 'accepted') {
        operation.phase = 'unknown'
        operation.notice = unknown
      }
    } catch {
      if (!live.current || version !== epoch.current || operations.current.get(id) !== operation) return
      operation.failures++
      if (operation.phase !== 'accepted') { operation.phase = 'unknown'; operation.notice = unknown }
      else operation.notice = '删除进度查询失败，尚未确认清理完成；稍后自动查询。'
    } finally {
      if (live.current && version === epoch.current && operations.current.get(id) === operation) {
        operation.busy = false
        operation.retryAt = retryAt
        operation.next = Math.max(retryAt, Date.now() + Math.min(30000, 2000 * 2 ** Math.min(operation.failures, 4)))
        changed()
      }
    }
  }
  const hasPending = [...operations.current.values()].some(operation => operation.phase !== 'rejected')
  useEffect(() => {
    if (!active || !hasPending) return
    const resume = (immediate = false) => {
      if (document.visibilityState !== 'visible') return
      for (const [id, operation] of operations.current) {
        if (operation.phase !== 'rejected' && operation.phase !== 'requesting' && Date.now() >= (immediate ? operation.retryAt : operation.next)) void perform(id, false)
      }
    }
    const visible = () => resume(true)
    resume(true)
    const timer = window.setInterval(() => resume(), 500)
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
    // 操作属于页面而非当前视图，切页不重建定时器或重发 DELETE。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hasPending])
  function remove(file: FileMessage) {
    const old = operations.current.get(file.file_id)
    if (!live.current || old?.busy || (old && Date.now() < old.retryAt) || file.file_state === 'deleting' || file.file_state === 'deleted') return
    if (!window.confirm(`删除服务器上的「${file.file_name}」？所有设备后续将无法下载，本地副本不受影响。操作不可恢复。${old?.phase === 'unknown' ? '\n原请求仍可能执行；再次确认重试不等于取消原请求。' : ''}`)) return
    operations.current.set(file.file_id, { phase: 'requesting', notice: '删除请求处理中…', next: 0, retryAt: 0, failures: 0, busy: false })
    changed()
    void perform(file.file_id, true)
  }
  return { remove, suspend, usageRevision, operation: (id: string) => operations.current.get(id),
    blocksDownload: (id: string) => { const phase = operations.current.get(id)?.phase; return Boolean(phase && phase !== 'rejected') } }
}
