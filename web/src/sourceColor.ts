// Keep color values in theme.css; this module only chooses a stable visual category.
const sourceColors = ['blue', 'purple', 'teal', 'green', 'orange', 'red'] as const

export function getSourceColor(label?: string): typeof sourceColors[number] {
  const source = label?.trim() || '我'
  let hash = 0
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  }
  return sourceColors[hash % sourceColors.length]
}
