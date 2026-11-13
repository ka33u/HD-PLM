// Verify shipped previews match their catalog before building a release.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = new URL('../docs/sop/', import.meta.url)
const catalog = JSON.parse(
  await readFile(new URL('catalog.json', root), 'utf8'),
)
for (const guide of catalog) {
  if (
    !['design', 'production', 'procurement'].includes(guide.id) ||
    !guide.pages.length
  )
    throw new Error('Invalid SOP catalog')
  const required = [
    `${guide.id}.pptx`,
    `${guide.id}.pdf`,
    ...guide.pages.map((_, i) => `${guide.id}/${i + 1}.webp`),
  ]
  for (const path of required) {
    const expected = guide.assets[path]
    const bytes = await readFile(new URL(path, root))
    if (
      !expected ||
      expected.size !== bytes.length ||
      expected.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error(
        `SOP asset mismatch: ${fileURLToPath(new URL(path, root))}; regenerate previews with scripts/prepare-sop.py`,
      )
  }
}
await readFile(new URL('../docs/设计部新品跟踪管理程序.docx', import.meta.url))
console.log(
  `SOP 部署文件校验通过：${catalog.length} 份 / ${catalog.reduce((sum, item) => sum + item.pages.length, 0)} 页`,
)
