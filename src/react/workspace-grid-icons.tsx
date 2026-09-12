// Preserved from the pre-kernel grid (2106634).
export function FilterIcon() {
  return <svg
    aria-hidden="true"
    className="business-grid__header-action-icon"
    fill="none"
    viewBox="0 0 16 16"
  >
    <path d="M2.5 3h11L9.25 7.8v3.45l-2.5 1.5V7.8L2.5 3Z" />
  </svg>
}

export function SortIcon({ direction }: { direction: 'ascending' | 'descending' | undefined }) {
  if (direction === 'ascending') {
    return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
      <path d="M4.25 13V3m0 0L2 5.25M4.25 3 6.5 5.25M8.5 4h5M8.5 8h3.5m-3.5 4H11" />
    </svg>
  }
  if (direction === 'descending') {
    return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
      <path d="M4.25 3v10m0 0L2 10.75M4.25 13l2.25-2.25M8.5 4H11M8.5 8H12m-3.5 4h5" />
    </svg>
  }
  return <svg aria-hidden="true" className="business-grid__header-action-icon" fill="none" viewBox="0 0 16 16">
    <path d="M5 2.5v11m0-11L2.75 4.75M5 2.5l2.25 2.25m3.75 8.75v-11m0 11-2.25-2.25M11 13.5l2.25-2.25" />
  </svg>
}

