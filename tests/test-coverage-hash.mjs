import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/mnemazine-coverage-check.mjs', import.meta.url))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemazine-coverage-hash-'))
try {
  const vault = path.join(temp, 'vault'), inbox = path.join(temp, 'inbox')
  fs.mkdirSync(vault); fs.mkdirSync(inbox)
  const source = path.join(inbox, 'renamed-source.txt')
  const data = 'Fixture source content for independently calculated SHA-256 coverage.'
  fs.writeFileSync(source, data)
  const hash = createHash('sha256').update(data).digest('hex')
  const note = `---\nstatus: "final"\nverified: подтвержден\nverification_status: "verified"\nenrichment: "external-research"\n---\n# Проверенная фикстура\n\n## Источники\n\nlocal-media:${hash.slice(0, 16)}\n\nПубличные источники:\n- https://example.com/source\n\n## Расширение знания\n\nФакты, добавленные до атомизации:\n- Первый проверенный факт фикстуры.\n- Второй проверенный факт фикстуры.\n`
  const file = path.join(vault, 'knowledge.md')
  const check = () => spawnSync(process.execPath, [script, '--vault', vault, '--inbox', inbox, '--json'], { encoding: 'utf8', timeout: 5000 })
  fs.writeFileSync(file, note)
  assert.equal(check().status, 0, 'renamed source covered by matching verified SHA-256 source_ref')
  fs.writeFileSync(source, `${data} changed`)
  assert.equal(check().status, 1, 'different bytes must not match old hash')
  fs.writeFileSync(source, data)
  fs.writeFileSync(file, note.replace('status: "final"', 'status: "draft"'))
  assert.equal(check().status, 1, 'draft with correct source hash does not prove coverage')
  fs.writeFileSync(file, note.replace('verified: подтвержден', 'verified: не-проверялось'))
  assert.equal(check().status, 1, 'unverified source hash must not count')
  fs.writeFileSync(file, 'Source: renamed-source.txt')
  assert.equal(check().status, 0, 'existing basename contract remains intact')
  console.log('coverage hash passed: renamed verified source, changed bytes, draft/unverified rejection, basename compatibility')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
