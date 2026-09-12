import { observeResize } from './workspace-resize.js'
import { useLayoutEffect, useRef, useState } from 'react'

/** Presentation only. Hidden chips never change the stored choice membership. */
export function WorkspaceChoiceCell({ labels, emptyLabel }: Readonly<{ labels: readonly string[]; emptyLabel: string }>) {
  const container = useRef<HTMLSpanElement>(null), measurement = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(labels.length)
  // Parent snapshots can recreate the label array without changing any label.
  // Reobserve only when its contents change, not on unrelated editing input.
  const labelKey = JSON.stringify(labels)
  useLayoutEffect(() => {
    const node = container.current, measure = measurement.current
    if (!node || !measure) return
    const update = () => {
      const tags = [...measure.querySelectorAll<HTMLElement>('[data-tag-measure]')]
      const overflow = measure.querySelector<HTMLElement>('[data-overflow-measure]')!
      const gap = parseFloat(getComputedStyle(node).columnGap) || 0, available = node.clientWidth
      const widths = tags.map(tag => tag.getBoundingClientRect().width)
      if (widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, labels.length - 1) <= available) {
        setVisible(labels.length); return
      }
      let used = 0, count = 0
      for (const width of widths) {
        const next = used + (count ? gap : 0) + width
        if (next + gap + overflow.getBoundingClientRect().width > available) break
        used = next; count++
      }
      setVisible(count)
    }
    update()
    return observeResize([node, measure], update)
  }, [labelKey])
  const count = Math.min(visible, labels.length), label = labels.join(', ') || emptyLabel
  return <span ref={container} role="group" aria-label={label} title={label} className="data-grid-tag-list">
    {!labels.length ? <span className="data-grid-tag-list__empty">{emptyLabel}</span> : labels.slice(0, count).map((label, index) =>
      <span aria-hidden="true" className="data-grid-tag" key={index}>{label}</span>)}
    {count < labels.length ? <span aria-hidden="true" className="data-grid-tag data-grid-tag--overflow">+{labels.length - count}</span> : null}
    <span aria-hidden="true" className="data-grid-tag-measurements" ref={measurement}>
      {labels.map((label, index) => <span className="data-grid-tag" data-tag-measure key={index}>{label}</span>)}
      <span className="data-grid-tag data-grid-tag--overflow" data-overflow-measure>+{labels.length}</span>
    </span>
  </span>
}
