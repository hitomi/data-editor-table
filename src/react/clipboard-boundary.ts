import type { GridCommandResult } from '../controller/grid-controller.js'

export type GridClipboardFailureMessages = Readonly<{
  unavailable: string
  writeFailed: string
}>

type ReportRejected = (result: GridCommandResult) => void

/** Extracts a controller-owned copy payload and reports every rejected path. */
export function gridClipboardText(
  result: GridCommandResult<Readonly<{ text: string }>>,
  reportRejected: ReportRejected,
  malformedPayloadMessage: string,
) {
  if (!result.accepted) {
    reportRejected(result)
    return null
  }
  if (
    typeof result.value === 'object' &&
    result.value !== null &&
    'text' in result.value &&
    typeof result.value.text === 'string'
  ) return result.value.text
  reportRejected(rejection(result.revision, malformedPayloadMessage))
  return null
}

/**
 * Writes a prepared selection through the asynchronous Clipboard API.
 * Keyboard copy intentionally uses the native `copy` event instead.
 */
export function writeGridClipboard(
  result: GridCommandResult<Readonly<{ text: string }>>,
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

function rejection(revision: number, reason: string): GridCommandResult {
  return { accepted: false, revision, issue: { code: 'adapter-error', domainCode: 'clipboard', message: reason } }
}
