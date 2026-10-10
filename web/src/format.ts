export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(n) / Math.log(k))
  const idx = Math.min(Math.max(i, 0), units.length - 1)
  if (idx === 0) return `${n} B`
  const val = n / Math.pow(k, idx)
  const formatted = val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)
  return `${parseFloat(formatted)} ${units[idx]}`
}

export function formatMessageTime(dateInput: string | Date | number): string {
  const date = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput
  if (isNaN(date.getTime())) return String(dateInput)

  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

export function formatMessageDate(dateInput: string | Date | number): string {
  const date = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput
  if (isNaN(date.getTime())) return String(dateInput)

  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  return `${year}-${month}-${day}`
}

export type FileCategory = 'document' | 'image' | 'video' | 'other'

export function getFileCategory(filename: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'yaml', 'xml'].includes(ext)) {
    return 'document'
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) {
    return 'image'
  }
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v'].includes(ext)) {
    return 'video'
  }
  return 'other'
}

export function getAvatarInitial(label?: string): string {
  if (!label) return '我'
  const clean = label.replace(/^[\s\u0085\u3000\u200b\ufeff]+/, '').trim()
  if (!clean) return '我'
  const first = [...clean][0]
  return first ? first.toUpperCase() : '我'
}
