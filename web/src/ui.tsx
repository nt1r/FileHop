import {
  FileArchiveIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
} from '@phosphor-icons/react'
import { getAvatarInitial } from './format'
import { getSourceColor } from './sourceColor'

export function UserAvatar({
  label = '我',
  size = 36,
  className = '',
}: {
  label?: string
  size?: number
  className?: string
}) {
  const initial = getAvatarInitial(label)
  const fontSize = Math.max(12, Math.round(size * 0.44))

  return (
    <div
      className={`user-avatar-circle ${className}`}
      data-source-color={getSourceColor(label)}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        fontSize: `${fontSize}px`,
      }}
      aria-hidden="true"
    >
      <span className="user-avatar-initial">{initial}</span>
    </div>
  )
}

export function FileTypeBadge({
  filename,
  size = 'md',
}: {
  filename: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''

  if (ext === 'pdf') {
    return (
      <div className={`file-badge file-badge-pdf ${size}`}>
        <span className="file-badge-text">pdf</span>
      </div>
    )
  }
  if (['doc', 'docx'].includes(ext)) {
    return (
      <div className={`file-badge file-badge-word ${size}`}>
        <span className="file-badge-text">W</span>
      </div>
    )
  }
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return (
      <div className={`file-badge file-badge-excel ${size}`}>
        <span className="file-badge-text">X</span>
      </div>
    )
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
    return (
      <div className={`file-badge file-badge-image ${size}`}>
        <FileImageIcon size={size === 'lg' ? 24 : size === 'sm' ? 14 : 18} weight="fill" />
      </div>
    )
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
    return (
      <div className={`file-badge file-badge-archive ${size}`}>
        <FileArchiveIcon size={size === 'lg' ? 24 : size === 'sm' ? 14 : 18} weight="fill" />
      </div>
    )
  }
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) {
    return (
      <div className={`file-badge file-badge-video ${size}`}>
        <FileVideoIcon size={size === 'lg' ? 24 : size === 'sm' ? 14 : 18} weight="fill" />
      </div>
    )
  }
  return (
    <div className={`file-badge file-badge-generic ${size}`}>
      <FileTextIcon size={size === 'lg' ? 24 : size === 'sm' ? 14 : 18} weight="fill" />
    </div>
  )
}
