/** Resize delivery must not synchronously render into the geometry it observes.
 * Coalesce notifications and read current geometry on the next animation frame. */
export function observeResize(elements: readonly Element[], measure: () => void): () => void {
  let frame: number | null = null
  const observer = new ResizeObserver(() => {
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure() })
  })
  for (const element of elements) observer.observe(element)
  return () => {
    observer.disconnect()
    if (frame !== null) { cancelAnimationFrame(frame); frame = null }
  }
}
