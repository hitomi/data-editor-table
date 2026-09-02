import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const [needle, ...inputs] = process.argv.slice(2)

if (!needle || inputs.length === 0) {
  throw new Error('Usage: node scripts/assert-text-absent.mjs <text> <path...>')
}

const files = []
for (const input of inputs) await collectFiles(resolve(input), files)

let found = false
for (const file of files) {
  const contents = await readFile(file, 'utf8')
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.includes(needle)) continue
    found = true
    process.stdout.write(`${file}:${index + 1}:${line}\n`)
  }
}

if (found) process.exitCode = 1

async function collectFiles(path, files) {
  const entry = await stat(path)
  if (entry.isFile()) {
    files.push(path)
    return
  }
  if (!entry.isDirectory()) return
  const children = await readdir(path, { withFileTypes: true })
  for (const child of children) {
    if (child.name === 'node_modules' || child.name === 'dist') continue
    await collectFiles(resolve(path, child.name), files)
  }
}
