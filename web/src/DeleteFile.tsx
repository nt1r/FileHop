import { Button } from '@cloudflare/kumo/components/button'
import { Text } from '@cloudflare/kumo/components/text'
import type { Message } from './messages'
import type { useDeletion } from './deletion'

export default function DeleteFile({ file, deletion }: { file: Extract<Message, { kind: 'FILE' }>; deletion: ReturnType<typeof useDeletion> }) {
  const operation = deletion.operation(file.file_id)
  return <>
    {operation?.notice && <Text role="status">{operation.notice}</Text>}
    {(file.file_state === 'available' || file.file_state === 'storage_error') && <Button variant="ghost" size="sm"
      disabled={operation?.busy || operation?.phase === 'accepted'}
      onClick={() => deletion.remove(file)}>{operation?.phase === 'unknown' ? '再次确认删除' : '删除服务器文件'}</Button>}
  </>
}
