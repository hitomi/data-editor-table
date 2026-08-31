import type { CSSProperties, Ref } from 'react'

import { classNames } from './class-names.js'

// Migrated from Huifan packages/ui/data-grid/selection-overlay.tsx.

export function DataGridSelectionOverlay({
  animated,
  className,
  fillHandleRef,
  fillHandleVisible = false,
  overlayRef,
  style,
}: {
  animated: boolean
  className?: string
  fillHandleRef?: Ref<HTMLDivElement>
  fillHandleVisible?: boolean
  overlayRef?: Ref<HTMLDivElement>
  style: CSSProperties
}) {
  return (
    <>
      <div className="operational-data-grid-selection-viewport">
        <div
          ref={overlayRef}
          data-testid="range-selection-overlay"
          data-selection-motion={animated ? 'selection' : 'viewport'}
          className={classNames('operational-data-grid-selection-overlay', className)}
          style={style}
        />
      </div>
      {fillHandleVisible ? <div
        ref={fillHandleRef}
        aria-hidden="true"
        data-testid="range-fill-handle-visual"
        data-selection-motion={animated ? 'selection' : 'viewport'}
        className="operational-data-grid-fill-handle-visual"
        style={style}
      /> : null}
    </>
  )
}
