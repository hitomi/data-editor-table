export const DATA_GRID_CLIPBOARD_CHARACTER_LIMIT = 10_000_000
export const DATA_GRID_CLIPBOARD_CELL_LIMIT = 100_000

export type ParseDataGridClipboardOptions = {
  characterLimit?: number
  cellLimit?: number
}

/** Parse an RFC-4180-style, tab-delimited clipboard matrix without a CSV dependency. */
export function parseDataGridClipboard(
  text: string,
  options: ParseDataGridClipboardOptions = {},
): string[][] {
  const characterLimit = options.characterLimit ?? DATA_GRID_CLIPBOARD_CHARACTER_LIMIT
  const cellLimit = options.cellLimit ?? DATA_GRID_CLIPBOARD_CELL_LIMIT
  if (text.length > characterLimit) {
    throw new Error(`Clipboard content exceeds the ${characterLimit.toLocaleString()} character limit.`)
  }

  const rows: string[][] = [[]]
  let value = ''
  let quoted = false
  let cellCount = 0

  const commitCell = () => {
    rows.at(-1)!.push(value)
    value = ''
    cellCount += 1
    if (cellCount > cellLimit) {
      throw new Error(`Clipboard content exceeds the ${cellLimit.toLocaleString()} cell limit.`)
    }
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        value += character
      }
      continue
    }
    if (character === '"' && value.length === 0) {
      quoted = true
    } else if (character === '\t') {
      commitCell()
    } else if (character === '\n' || character === '\r') {
      commitCell()
      rows.push([])
      if (character === '\r' && text[index + 1] === '\n') index += 1
    } else {
      value += character
    }
  }
  if (quoted) throw new Error('Clipboard content contains an unterminated quoted cell.')
  commitCell()
  if (rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop()
  return rows
}
