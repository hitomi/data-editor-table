export function encodeClipboardMatrix(matrix: readonly (readonly string[])[]): string {
  return matrix.map((row) => row.map(quoteClipboardCell).join('\t')).join('\n')
}

export function decodeClipboardMatrix(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [[]]
  let value = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
      continue
    }
    if (character === '"' && value.length === 0) quoted = true
    else if (character === '\t') {
      rows.at(-1)!.push(value)
      value = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      rows.at(-1)!.push(value)
      rows.push([])
      value = ''
    } else value += character
  }
  rows.at(-1)!.push(value)
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === '') rows.pop()
  return Object.freeze(rows.map((row) => Object.freeze(row)))
}

function quoteClipboardCell(value: string) {
  if (!/[\t\r\n"]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}
