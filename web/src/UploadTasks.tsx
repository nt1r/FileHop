import { Button } from '@cloudflare/kumo/components/button'
import { Text } from '@cloudflare/kumo/components/text'
import type { useFiles } from './files'
import { formatBytes } from './format'
import { FileTypeBadge } from './ui'

export default function UploadTasks({ files }: { files: ReturnType<typeof useFiles> }) {
  if (!files.paused && !files.tasks.length && typeof files.limits === 'number') return null
  return (
    <section className="upload-feedback" aria-label="文件上传任务">
      {files.paused && (
        <div className="upload-paused-banner">
          <Text role="status" variant="secondary" size="sm">
            暂停新上传：网络不可用或仍有结果未确认。未确认项须手动查询或结束本轮，不会自动查询或重传。
          </Text>
        </div>
      )}

      {(files.limits === 'unavailable' || files.limits === 'loading') && (
        <div className="upload-tip-box">
          <Text variant="secondary" size="sm">
            {files.limits === 'loading' ? '正在读取服务器文件限制…' : '限制未知或离线，暂不可选择文件。'}
          </Text>
          {files.limits === 'unavailable' && (
            <Button variant="ghost" size="sm" onClick={() => void files.refresh()}>
              重查文件限制
            </Button>
          )}
        </div>
      )}

      {files.tasks.length > 0 && (
        <div className="upload-tasks-section">
          <div className="upload-batch-toolbar">
            <span className="upload-queue-count">上传任务 ({files.tasks.length})</span>
            <Button variant="ghost" size="sm" onClick={files.endBatch}>
              结束本轮
            </Button>
          </div>
          <div className="upload-tasks-list">
            {files.tasks.map(task => (
              <div className="upload-task" key={task.sendId}>
                <div className="upload-task-info">
                  <FileTypeBadge filename={task.name} size="sm" />
                  <Text DANGEROUS_className="upload-task-title">{task.name} · {formatBytes(task.size)}</Text>
                </div>
                <progress max={100} value={task.progress} aria-label={`${task.name} 上传进度`} />
                <div className="upload-task-footer">
                  <Text role="status" variant={task.status === '上传成功' ? 'success' : task.pending ? 'secondary' : 'error'} size="sm">
                    {task.status}
                  </Text>
                  <div className="upload-task-actions">
                    {task.queued && <Button variant="ghost" size="sm" onClick={() => files.remove(task.sendId)}>移除等待项</Button>}
                    {task.pending && !task.unresolved && <Button variant="secondary" size="sm" onClick={() => files.interrupt(task.sendId)}>中断传输</Button>}
                    {task.unresolved && !task.pending && <Button variant="secondary" size="sm" onClick={() => void files.query(task.sendId)}>查询文件结果</Button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
