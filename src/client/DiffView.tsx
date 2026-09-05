/**
 * Red/green diff renderer — the display half of the compute/render split.
 *
 * The host computes unified hunks once (src/diff.ts); this component only
 * classifies each line by its first character (the ~10-line parseLineType
 * trick from the reference analysis) into a data-line-type attribute. All
 * coloring lives in CSS (token-driven color-mix over the base surface), so
 * skins re-theme the diff without touching JS, and React's text rendering
 * keeps content XSS-safe without any escaping dance.
 */
import { createElement, useState } from 'react'
import type { DiffHunk } from './api'

/** Classify one unified-diff line by its marker character. */
function parseLineType(line: string): 'context' | 'metadata' | 'addition' | 'deletion' {
  const first = line.charAt(0)
  if (first === ' ') return 'context'
  if (first === '\\') return 'metadata'
  if (first === '+') return 'addition'
  return 'deletion'
}

/** Default render cap before the "show everything" button appears. */
const MAX_RENDER_LINES = 800

export function DiffView(props: { hunks: DiffHunk[]; emptyText?: string }): React.ReactNode {
  const [expanded, setExpanded] = useState(false)

  if (props.hunks.length === 0) {
    return createElement(
      'div',
      { className: 'fu-diff-identical' },
      props.emptyText ?? '内容一致 — 撤销前后没有可显示的差异',
    )
  }

  // Flatten into typed row descriptors with paired line numbers.
  const rows: Array<{ type: ReturnType<typeof parseLineType>; oldNo: number | null; newNo: number | null; text: string }> = []
  for (const hunk of props.hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const line of hunk.lines) {
      const type = parseLineType(line)
      const oldNum = type === 'addition' || type === 'metadata' ? null : oldNo
      const newNum = type === 'deletion' || type === 'metadata' ? null : newNo
      if (type !== 'addition' && type !== 'metadata') oldNo++
      if (type !== 'deletion' && type !== 'metadata') newNo++
      rows.push({ type, oldNo: oldNum, newNo: newNum, text: line.slice(1) })
    }
  }

  const capped = !expanded && rows.length > MAX_RENDER_LINES
  const visible = capped ? rows.slice(0, MAX_RENDER_LINES) : rows

  return createElement(
    'div',
    { className: 'fu-diff-wrap' },
    createElement(
      'div',
      { className: 'fu-diff' },
      props.hunks.map((hunk, hunkIndex) => {
        // Find the row offset where this hunk's lines begin.
        let before = 0
        for (let h = 0; h < hunkIndex; h++) before += props.hunks[h].lines.length
        const hunkRows = visible.slice(before, before + hunk.lines.length)
        const fullyRendered = hunkRows.length === hunk.lines.length
        return createElement(
          'div',
          { key: `hunk-${hunkIndex}` },
          createElement(
            'div',
            { className: 'fu-hunk-head' },
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ),
          ...(fullyRendered
            ? hunkRows.map((row, i) => diffRow(row, `${hunkIndex}-${i}`))
            : []),
        )
      }),
      capped
        ? createElement(
            'div',
            { className: 'fu-diff-more' },
            `已省略 ${rows.length - MAX_RENDER_LINES} 行… `,
            createElement('button', { className: 'fu-diff-more-btn', onClick: () => setExpanded(true) }, '显示全部差异'),
          )
        : null,
    ),
  )
}

function diffRow(
  row: { type: ReturnType<typeof parseLineType>; oldNo: number | null; newNo: number | null; text: string },
  key: string,
): React.ReactNode {
  return createElement(
    'div',
    { key, className: 'fu-diff-row', 'data-line-type': row.type },
    createElement('span', { className: 'fu-diff-no' }, row.oldNo === null ? '' : String(row.oldNo)),
    createElement('span', { className: 'fu-diff-no' }, row.newNo === null ? '' : String(row.newNo)),
    createElement('span', { className: 'fu-diff-content' }, row.text),
  )
}
