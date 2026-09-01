import { copyFile, mkdir } from 'node:fs/promises'

const sourceRoot = new URL('../src/', import.meta.url)
const outputRoot = new URL('../dist/', import.meta.url)
const styleAssets = ['styles.css', 'structure.css', 'theme.css']

await mkdir(outputRoot, { recursive: true })
await Promise.all(styleAssets.map((fileName) => copyFile(
  new URL(fileName, sourceRoot),
  new URL(fileName, outputRoot),
)))
