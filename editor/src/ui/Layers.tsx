import { useEffect, useRef, useState } from 'preact/hooks'
import { batch } from '@preact/signals'
import { collapsed, commit, project, select, selEls } from '../state'
import {
  activeFolder, addElement, addFolder, pickVisual, deleteFolder, folderIdOf, folderMembers, groupSelection, layerRows, moveFolder, moveLayer, putInFolder,
  renameFolder, toggleFolderHidden,
} from '../ops'
import { Menu } from './fields'
import { Icon } from './icons'
import type { El, Folder } from '../types'

// Focuses itself on mount (the autofocus attribute is unreliable on inserted inputs).
function RenameInput(props: { value: string; done: (v: string) => void; stop: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      class="rename"
      value={props.value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        if (e.key === 'Escape') props.stop()
      }}
      onBlur={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value.trim()
        if (v && v !== props.value) props.done(v)
        props.stop()
      }}
    />
  )
}

type Drag = { kind: 'el' | 'folder'; id: string }
type Drop = { id: string; where: 'above' | 'below' | 'into' }

function toggleCollapsed(id: string) {
  const s = new Set(collapsed.value)
  s.has(id) ? s.delete(id) : s.add(id)
  collapsed.value = s
}

const ICON: Record<El['type'], string> = { text: 'T', rect: '▭', ellipse: '◯', path: '∿', image: '▣', video: '▶', group: '▤' }

export function Layers() {
  const p = project.value
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!p) return null
  const rows = layerRows(p)
  const sel = new Set(selEls.value)

  const add: [string, () => void][] = [
    ['Text', () => addElement('text')],
    ['Rectangle', () => addElement('rect')],
    ['Ellipse', () => addElement('ellipse')],
    ['Curve (path)', () => addElement('path')],
    ['Arrow', () => addElement('path', { w: 400, h: 80, d: 'M10 40 H 370 M 330 10 L 375 40 L 330 70', stroke: '#5ef1ff', strokeWidth: 10 }, 'Arrow')],
    ['Image…', () => pickVisual('image/*')],
    ['Video…', () => pickVisual('video/*,.mkv,.mov,.mts')],
  ]
  if (selEls.value.length > 1) add.push(['Group selected (ctrl+g)', () => groupSelection(selEls.value)])

  const newFolder = () => {
    const fid = addFolder()
    if (fid) setRenaming(fid)
  }

  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }

  const renameInput = (value: string, done: (v: string) => void) => <RenameInput value={value} done={done} stop={() => setRenaming(null)} />

  const folderRow = (f: Folder | null, key: string, count: number) => {
    const members = folderMembers(p, f?.id ?? null)
    const allHidden = members.length > 0 && members.every((e) => e.hidden)
    const isSel = members.length > 0 && members.every((e) => sel.has(e.id))
    return (
      <div
        class={`layer folder ${isSel ? 'sel' : ''} ${activeFolder.value === f?.id ? 'active' : ''} ${drop?.id === key ? `drop-${drop.where}` : ''} ${drag?.id === key ? 'dragging' : ''}`}
        draggable={!!f && renaming !== key}
        onDragStart={(e) => {
          setDrag({ kind: 'folder', id: key })
          e.dataTransfer!.effectAllowed = 'move'
          e.dataTransfer!.setData('text/plain', key)
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!drag || drag.id === key) return
          if (drag.kind === 'folder' && !f) return
          e.preventDefault()
          if (drag.kind === 'el') return setDrop({ id: key, where: 'into' })
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setDrop({ id: key, where: e.clientY - r.top < r.height / 2 ? 'above' : 'below' })
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (drag?.kind === 'el') putInFolder(sel.has(drag.id) ? [...sel] : [drag.id], f?.id ?? null)
          else if (drag?.kind === 'folder' && f && drop && drop.where !== 'into') moveFolder(drag.id, f.id, drop.where)
          endDrag()
        }}
        onClick={() =>
          batch(() => {
            select('el', null)
            selEls.value = members.map((m) => m.id)
            activeFolder.value = f?.id ?? null
          })
        }
        title="Click to select everything in it. Drag layers onto it to file them."
      >
        <button
          class="caret"
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapsed(key)
          }}
        >
          {collapsed.value.has(key) ? '▸' : '▾'}
        </button>
        <span class="icon folder-icon"><Icon name="folder" size={12} /></span>
        {f && renaming === key ? (
          renameInput(f.name, (v) => renameFolder(f.id, v))
        ) : (
          <span class="name" onDblClick={() => f && setRenaming(key)}>{f ? f.name : 'Unfiled'}</span>
        )}
        <span class="count">{count}</span>
        <button
          class={`tiny ${allHidden ? 'on' : ''}`}
          title={allHidden ? 'Show all' : 'Hide all'}
          onClick={(e) => {
            e.stopPropagation()
            toggleFolderHidden(f?.id ?? null)
          }}
        >
          {allHidden ? '◌' : '●'}
        </button>
        {f ? (
          <button
            class="tiny"
            title="Remove folder (keeps what's in it)"
            onClick={(e) => {
              e.stopPropagation()
              deleteFolder(f.id)
            }}
          >
            ✕
          </button>
        ) : (
          <span class="tiny" />
        )}
      </div>
    )
  }

  const elRow = (el: El, depth: number) => (
    <div
      class={`layer ${sel.has(el.id) ? 'sel' : ''} ${el.hidden ? 'dim' : ''} ${drop?.id === el.id ? `drop-${drop.where}` : ''} ${drag?.id === el.id ? 'dragging' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      draggable={renaming !== el.id}
      onDragStart={(e) => {
        setDrag({ kind: 'el', id: el.id })
        e.dataTransfer!.effectAllowed = 'move'
        e.dataTransfer!.setData('text/plain', el.id)
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (!drag || drag.kind !== 'el' || drag.id === el.id) return
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const f = (e.clientY - r.top) / r.height
        const where = el.type === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below'
        setDrop({ id: el.id, where })
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (drag?.kind === 'el' && drop) moveLayer(drag.id, drop.id, drop.where)
        endDrag()
      }}
      onClick={(e) => {
        select('el', el.id, e.shiftKey)
        activeFolder.value = folderIdOf(el, p)
      }}
    >
      {el.type === 'group' ? (
        <button
          class="caret"
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapsed(el.id)
          }}
        >
          {collapsed.value.has(el.id) ? '▸' : '▾'}
        </button>
      ) : (
        <span class="caret" />
      )}
      <span class={`icon t-${el.type}`}>{ICON[el.type]}</span>
      {renaming === el.id ? (
        renameInput(el.name, (v) => commit((q) => (q.elements.find((x) => x.id === el.id)!.name = v)))
      ) : (
        <span class="name" onDblClick={() => setRenaming(el.id)}>{el.name}</span>
      )}
      <button
        class={`tiny ${el.hidden ? 'on' : ''}`}
        title={el.hidden ? 'Show' : 'Hide'}
        onClick={(e) => {
          e.stopPropagation()
          commit((q) => (q.elements.find((x) => x.id === el.id)!.hidden = !el.hidden || undefined))
        }}
      >
        {el.hidden ? '◌' : '●'}
      </button>
      <button
        class={`tiny ${el.locked ? 'on' : ''}`}
        title={el.locked ? 'Unlock' : 'Lock (canvas clicks pass through)'}
        onClick={(e) => {
          e.stopPropagation()
          commit((q) => (q.elements.find((x) => x.id === el.id)!.locked = !el.locked || undefined))
        }}
      >
        {el.locked ? <Icon name="lock" size={10} /> : '·'}
      </button>
    </div>
  )

  return (
    <aside class="layers">
      <header class="panel-head">
        <h3>Layers</h3>
        <span class="row-btns tight">
          <button class="btn xs" title={selEls.value.length ? 'New folder with the selected layers' : 'New folder'} onClick={newFolder}>
            <Icon name="folder" size={11} /> +
          </button>
          <Menu class="btn xs" label="+ Add" items={add} />
        </span>
      </header>
      <div
        class="layer-list"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return
          select('el', null)
          activeFolder.value = null
        }}
      >
        {!rows.length && <div class="muted-text pad">Empty. Add text or shapes with + Add, or ask Claude to write the scene.</div>}
        {rows.map((r) => (r.kind === 'folder' ? folderRow(r.folder, r.key, r.count) : elRow(r.el, r.depth)))}
      </div>
    </aside>
  )
}

