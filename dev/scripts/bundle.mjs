import {mkdir, readFile, writeFile} from 'node:fs/promises'
const logic = (await readFile('src/logic.js', 'utf8')).replace(
  'export function createPricebot',
  'function createPricebot'
)
const entry = (await readFile('src/index.js', 'utf8')).replace(
  /^import\s+\{\s*createPricebot\s*\}\s+from\s+['"]\.\/logic\.js['"];?\s*$/m,
  ''
)
await mkdir('dist', {recursive: true})
await writeFile('dist/index.bundle.js', `${logic}\n${entry}`)
