// Inline icons, so the UI never depends on which symbol fonts the browser has.
const P: Record<string, string> = {
  start: 'M4 3v10M13 3 6 8l7 5z',
  end: 'M12 3v10M3 3l7 5-7 5z',
  loop: 'M3 7a5 5 0 0 1 9-3l1 1M13 9a5 5 0 0 1-9 3l-1-1M13 2v3h-3M3 14v-3h3',
  dup: 'M5 5h8v8H5zM3 11V3h8',
  lock: 'M4 7h8v7H4zM6 7V5a2 2 0 0 1 4 0v2',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  undo: 'M6 4 3 7l3 3M3 7h7a3 3 0 0 1 0 6H8',
  redo: 'M10 4l3 3-3 3M13 7H6a3 3 0 0 0 0 6h2',
}

export function Icon({ name, size = 13 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style={{ display: 'block' }}>
      <path d={P[name]} />
    </svg>
  )
}
