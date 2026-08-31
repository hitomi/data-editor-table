import type { GridDispatchResult } from '../controller/grid-controller.js'

export type GridClipboardFailureMessages = Readonly<{
  unavailable: string
  writeFailed: string
}>

type ReportRejected = (result: GridDispatchResult) => void

/** Extracts a controller-owned copy payload and reports every rejected path. */
export function gridClipboardText(
  result: GridDispatchResult,
  reportRejected: ReportRejected,
  malformedPayloadMessage: string,
) {
  if (!result.accepted) {
    reportRejected(result)
    return null
  }
  if (
    typeof result.payload === 'object' &&
    result.payload !== null &&
    'text' in result.payload &&
    typeof (result.payload as { text?: unknown }).text === 'string'
  ) return (result.payload as { text: string }).text
  reportRejected(rejection(result.revision, malformedPayloadMessage))
  return null
}

/**
 * Writes a prepared selection through the asynchronous Clipboard API.
 * Keyboard copy intentionally uses the native `copy` event instead.
 */
export function writeGridClipboard(
  result: GridDispatchResult,
  reportRejected: ReportRejected,
  messages: GridClipboardFailureMessages,
) {
  const text = gridClipboardText(result, reportRejected, messages.writeFailed)
  if (text === null) return
  let clipboard: Clipboard | undefined
  try {
    clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  } catch {
    reportRejected(rejection(result.revision, messages.unavailable))
    return
  }
  if (typeof clipboard?.writeText !== 'function') {
    reportRejected(rejection(result.revision, messages.unavailable))
    return
  }
  try {
    void Promise.resolve(clipboard.writeText(text)).catch(() => {
      reportRejected(rejection(result.revision, messages.writeFailed))
    })
  } catch {
    reportRejected(rejection(result.revision, messages.writeFailed))
  }
}

function rejection(revision: number, reason: string): GridDispatchResult {
  return { accepted: false, revision, reason }
}
