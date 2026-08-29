import type { CSSProperties, Ref } from 'react'

import { classNames } from './class-names'

// Migrated from Huifan packages/ui/data-grid/selection-overlay.tsx.

export function DataGridSelectionOverlay({
  animated,
  className,
  overlayRef,
  style,
}: {
  animated: boolean
  className?: string
  overlayRef?: Ref<HTMLDivElement>
  style: CSSProperties
}) {
  return (
    <div className="operational-data-grid-selection-viewport">
      <div
        ref={overlayRef}
        data-testid="range-selection-overlay"
        data-selection-motion={animated ? 'selection' : 'viewport'}
        className={classNames('operational-data-grid-selection-overlay', className)}
        style={style}
      />
    </div>
  )
}
