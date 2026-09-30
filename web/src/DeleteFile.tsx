import { TrashIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo/components/button'
import { Text } from '@cloudflare/kumo/components/text'
import type { Message } from './messages'
import type { useDeletion } from './deletion'

export default function DeleteFile({ file, deletion }: { file: Extract<Message, { kind: 'FILE' }>; deletion: ReturnType<typeof useDeletion> }) {
  const operation = deletion.operation(file.file_id)
  const isConfirming = operation?.phase === 'unknown'
  return <div className="delete-file-wrapper">
    {operation?.notice && <Text role="status" DANGEROUS_className="delete-notice">{operation.notice}</Text>}
    {(file.file_state === 'available' || file.file_state === 'storage_error') && <Button
      variant={isConfirming ? 'destructive' : 'ghost'}
      size="sm"
      icon={isConfirming ? <WarningCircleIcon size={14} weight="bold" /> : <TrashIcon size={14} />}
      disabled={operation?.phase === 'requesting' || operation?.phase === 'accepted'}
      onClick={() => deletion.remove(file)}
    >
      {isConfirming ? '再次确认删除' : '删除服务器文件'}
    </Button>}
  </div>
}
