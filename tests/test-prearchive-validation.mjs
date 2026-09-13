import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemazine-prearchive-'))
try {
  const vault = path.join(tmp, 'vault'); fs.mkdirSync(vault)
  process.env.MNEMAZINE_VAULT = vault
  const { archiveAfterValidation } = await import('../scripts/mnemazine-run.mjs')
  const { loadSpecCeiling } = await import('../scripts/mnemazine-complete-check.mjs')
  const source = path.join(tmp, 'source.md'), archived = path.join(tmp, 'archived.md')
  fs.writeFileSync(source, 'Original fixture must survive failed validation.')
  const events = []
  const archive = async file => { events.push('archive'); fs.renameSync(file, archived); return archived }
  const items = [{ file: source, hash: 'fixture' }]
  await assert.rejects(archiveAfterValidation({ failed: 0, finish: { human_layer: { ok: false, code: 1 } }, items, archive, validate: async () => events.push('complete') }), /final validation failed/)
  assert(fs.existsSync(source))
  assert.deepEqual(events, [])
  await assert.rejects(archiveAfterValidation({ failed: 0, finish: { human_layer: { ok: true } }, items, archive, validate: async () => { events.push('complete'); throw new Error('spec ceiling failed') } }), /spec ceiling failed/)
  assert(fs.existsSync(source))
  assert.deepEqual(events, ['complete'])
  events.length = 0
  await archiveAfterValidation({ failed: 0, finish: { human_layer: { ok: true } }, items, archive, validate: async () => events.push('complete') })
  assert.deepEqual(events, ['complete', 'archive'])
  assert(fs.existsSync(archived))

  const state = path.join(tmp, '.mnemazine/state'); fs.mkdirSync(state, { recursive: true })
  const baseline = path.join(state, 'spec-ceiling.json')
  assert.match((await loadSpecCeiling({ root: tmp, vault })).error, /no baseline/)
  fs.writeFileSync(baseline, JSON.stringify({ vault, checked: 10, ceiling: 0 }))
  const before = fs.readFileSync(baseline, 'utf8')
  const loaded = await loadSpecCeiling({ root: tmp, vault })
  assert.equal(loaded.error, null)
  assert.equal(loaded.file, baseline)
  assert.match((await loadSpecCeiling({ root: tmp, vault: path.join(tmp, 'other-vault') })).error, /different vault/)
  assert.equal(fs.readFileSync(baseline, 'utf8'), before, 'baseline must not be copied, updated or fabricated')
  const scripts = path.join(tmp, 'scripts'); fs.mkdirSync(scripts)
  for (const name of ['coverage-check', 'vault-quality-gate', 'spec-ceiling', 'report-quality-gate', 'human-layer-gate']) fs.writeFileSync(path.join(scripts, `mnemazine-${name}.mjs`), 'console.log("fixture gate passed")\n')
  const jobState = path.join(tmp, 'job-state'), inbox = path.join(tmp, 'inbox'), reports = path.join(tmp, 'reports')
  for (const folder of [jobState, inbox, reports]) fs.mkdirSync(folder)
  fs.writeFileSync(path.join(inbox, 'source.md'), 'source fixture')
  fs.writeFileSync(path.join(reports, 'visual-knowledge-report.html'), '<html>fixture</html>')
  fs.writeFileSync(path.join(jobState, 'last-action-brief.md'), 'fixture brief')
  const pending = { ok: false, phase: 'pending_archive', pre_archive_ready: true, archive_pending: 1, processed: 1, deep: true, enrich_required: true, strict_archive_knowledge: true, synthesize: { atomized: 1, enriched: 1 }, vault }
  fs.writeFileSync(path.join(jobState, 'last-run.json'), JSON.stringify(pending))
  const check = (beforeArchive = true) => spawnSync(process.execPath, [path.join(repo, 'scripts/mnemazine-complete-check.mjs'), '--require-deep', ...(beforeArchive ? ['--before-archive'] : [])], { encoding: 'utf8', timeout: 10000, cwd: tmp, env: { ...process.env, MNEMAZINE_ROOT: tmp, MNEMAZINE_STATE: jobState, MNEMAZINE_INBOX: inbox, MNEMAZINE_REPORTS: reports, MNEMAZINE_VAULT: vault } })
  assert.equal(check().status, 0, 'valid pending state uses real canonical fixture baseline, not job-state baseline')
  assert.equal(check(false).status, 1, 'normal completion must reject pending archive')
  fs.writeFileSync(path.join(scripts, 'mnemazine-coverage-check.mjs'), 'console.error("fixture uncovered source");process.exit(1)\n')
  const failedCoverage = check()
  assert.equal(failedCoverage.status, 1)
  assert.match(failedCoverage.stdout, /coverage failed/)
  assert(fs.existsSync(path.join(inbox, 'source.md')))
  const producer = spawnSync(process.execPath, [path.join(repo, 'scripts/mnemazine-synthesize.mjs'), '--selftest'], { encoding: 'utf8', timeout: 10000, cwd: tmp, env: { ...process.env, MNEMAZINE_ROOT: repo, MNEMAZINE_VAULT: vault, MNEMAZINE_STATE: path.join(tmp, 'job-state'), MNEMAZINE_DEEP: '0' } })
  assert.equal(producer.status, 0, producer.stderr)
  console.log('prearchive passed: failed finish/complete retain source, gate-before-move, canonical vault-bound baseline, truthful producer sections')
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }
