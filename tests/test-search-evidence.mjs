import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evidenceExcerpt, verifyFindings, cloudReadable } from '../scripts/mnemazine-kb-search.mjs'
import { loadTaxonomy } from '../scripts/mnemazine-machine-class-gate.mjs'

const longNote = '# Документ\n' + 'Нерелевантное описание. '.repeat(600) + '\nЛазурный двигатель: ресурс 840 циклов.'
assert.ok(evidenceExcerpt(longNote, 'лазурный двигатель').includes('840 циклов'), 'evidence at the end is readable')
assert.ok(evidenceExcerpt(longNote, 'лазурный двигатель').length <= 2500)
const finding = { note: 'source.md', insight: 'Лазурный двигатель: ресурс 840 циклов.', relevance: 5 }
const corpus = new Map([['source.md', longNote]])
let result = await verifyFindings('лазурный двигатель', [finding], corpus, async prompt => {
  assert.ok(prompt.includes('840 циклов'))
  return { grounded: true, relevant: true, actionable: true }
}, true)
assert.equal(result.kept.length, 1)
result = await verifyFindings('лазурный двигатель', [finding], corpus, async () => { throw new Error('offline verifier fixture') }, true)
assert.deepEqual(result, { kept: [], dropped: 1 }, 'verifier error cannot certify evidence')
for (const verdict of [{}, { grounded: true, relevant: false }, { grounded: false, relevant: true }]) {
  result = await verifyFindings('лазурный двигатель', [finding], corpus, async () => verdict, true)
  assert.equal(result.kept.length, 0, 'missing/negative verdict is not support')
}
result = await verifyFindings('лазурный двигатель', [finding], new Map(), async () => { throw new Error('must not run for missing source') }, true)
assert.equal(result.kept.length, 0)
result = await verifyFindings('лазурный двигатель', Array(7).fill(finding), corpus, async () => ({ grounded: true, relevant: true }), true)
assert.equal(result.kept.length, 5)
assert.equal(result.dropped, 2, 'over-budget findings must not bypass verification')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-evidence-'))
try {
  const nested = path.join(tmp, '02 Здоровье', 'nested')
  await fs.mkdir(nested, { recursive: true })
  const privateFile = path.join(nested, 'private.md')
  await fs.writeFile(privateFile, '---\ndata_class: text\n---\nЛичное')
  assert.equal(cloudReadable(privateFile, loadTaxonomy()), false, 'nested private section cannot be downgraded')
  const ordinary = path.join(tmp, 'public.md')
  await fs.writeFile(ordinary, '---\ndata_class: public\n---\nОткрытое')
  assert.equal(cloudReadable(ordinary, loadTaxonomy()), true)
  await fs.writeFile(ordinary, 'Нет frontmatter')
  assert.equal(cloudReadable(ordinary, loadTaxonomy()), false, 'missing classification is private')
} finally { await fs.rm(tmp, { recursive: true, force: true }) }
console.log('search evidence regressions: passed')
