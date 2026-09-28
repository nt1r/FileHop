import { useEffect, useRef, useState } from 'react'
import { isFileStatus, type Message } from './messages'

type FileMessage = Extract<Message, { kind: 'FILE' }>
type Operation = { phase: 'requesting' | 'unknown' | 'accepted' | 'rejected'; notice: string; retryAt: number }
const unknown = '删除结果未确认：请手动刷新检查；原请求仍可能执行。重试不等于取消原请求。'

export function useDeletion(onExpired: () => void) {
  const operations = useRef(new Map<string, Operation>())
  const [, render] = useState(0)
  const epoch = useRef(0)
  useEffect(() => () => { epoch.current++; operations.current.clear() }, [])
  function changed() { render(n => n + 1) }
  async function perform(id: string, operation: Operation) {
    const version = epoch.current
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      if (version !== epoch.current) return
      const retry = response.headers.get('retry-after')
      if (retry) operation.retryAt = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0
      if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw Error()
      const value = await response.json()
      if (version !== epoch.current) return
      if (response.status === 401 && value?.code === 'session_invalid') { onExpired(); return }
      // FILE_IN_USE 是本次明确拒绝，不排队等待下载结束；之后只能由用户再次确认。
      if (response.status === 409 && value?.code === 'FILE_IN_USE') {
        operation.phase = 'rejected'
        operation.notice = '文件正在下载，本次删除已结束；下载结束后请再次确认删除。'
        return
      }
      if (!response.ok || !isFileStatus(value) || value.file_id !== id ||
        (value.file_state !== 'deleting' && value.file_state !== 'deleted')) throw Error()
      // 接受响应只说明本次请求结果，不更新共享消息或容量；完成情况由用户刷新快照确认。
      operation.phase = 'accepted'
      operation.notice = value.file_state === 'deleted' ? '服务器文件已删除，请手动刷新列表和用量。' : '删除处理中，空间尚未释放；请手动刷新列表和用量。'
    } catch {
      if (version !== epoch.current) return
      operation.phase = 'unknown'
      operation.notice = unknown
    } finally {
      // 切页和认证失效会卸载文件页；旧请求仍可能执行，但不能更新新页面或触发重新登录。
      if (version === epoch.current) changed()
    }
  }
  function remove(file: FileMessage) {
    const old = operations.current.get(file.file_id)
    if (old?.phase === 'requesting' || old?.phase === 'accepted' || (old && Date.now() < old.retryAt) || file.file_state === 'deleting' || file.file_state === 'deleted') return
    if (!window.confirm(`删除服务器上的「${file.file_name}」？所有设备后续将无法下载，本地副本不受影响。操作不可恢复。${old?.phase === 'unknown' ? '\n原请求仍可能执行；再次确认重试不等于取消原请求。' : ''}`)) return
    const operation: Operation = { phase: 'requesting', notice: '删除请求处理中…', retryAt: 0 }
    operations.current.set(file.file_id, operation)
    changed()
    void perform(file.file_id, operation)
  }
  return { remove, operation: (id: string) => operations.current.get(id),
    blocksDownload: (id: string) => { const phase = operations.current.get(id)?.phase; return Boolean(phase && phase !== 'rejected') } }
}
