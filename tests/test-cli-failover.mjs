import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverProviders, resolveExecutable, readCooldown, recordCooldown, classifyProcessFailure } from '../scripts/mnemazine-cli-runtime.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemazine-cli-failover-'))
const previous = { ...process.env }
try {
  process.env.MNEMAZINE_LLM = 'claude'
  process.env.MNEMAZINE_LLM_PROGRESS = '0'
  process.env.MNEMAZINE_CLI_COOLDOWNS = path.join(tmp, 'cooldowns')
  process.env.FIXTURE_CALLS = path.join(tmp, 'calls')
  delete process.env.MNEMAZINE_CLI_REGISTRY_LOCAL
  delete process.env.MNEMAZINE_JOB_GROUPS
  delete process.env.MNEMAZINE_LLM_FALLBACK
  const mock = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.FIXTURE_CALLS, name+'\\n');
if(name==='claude' && process.env.FIXTURE_MODE==='timeout') { setInterval(()=>{},1000); }
else if(name==='claude' && process.env.FIXTURE_MODE==='quota') { console.error('quota exceeded; private-token-fixture');process.exitCode=1; }
else if(name==='claude' && process.env.FIXTURE_MODE==='bad') { console.log('not json'); }
else { const value=JSON.stringify({ok:true}); const i=process.argv.indexOf('-o'); if(i>=0)fs.writeFileSync(process.argv[i+1],value); else console.log(value); }
`
  for (const name of ['claude', 'codex', 'kimi']) {
    const file = path.join(tmp, name); fs.writeFileSync(file, mock, { mode: 0o700 })
    process.env[`MNEMAZINE_${name.toUpperCase()}_BIN`] = file
  }
  const { llmJson, llmText } = await import('../scripts/mnemazine-llm.mjs')
  const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
  process.env.FIXTURE_MODE = 'quota'
  const first = { provider: 'claude', dataClass: 'text' }
  assert.deepEqual(await llmJson('fixture only', schema, first), { ok: true })
  assert.equal(first.provider_used, 'kimi')
  assert.equal(first.attempts[0].reason, 'quota')
  assert(readCooldown('claude'))
  const second = { provider: 'claude', dataClass: 'text' }
  await llmJson('fixture only', schema, second)
  assert.equal(second.attempts[0].status, 'skipped')
  assert.equal(fs.readFileSync(process.env.FIXTURE_CALLS, 'utf8').split('\n').filter(x => x === 'claude').length, 1)
  const before = fs.readFileSync(process.env.FIXTURE_CALLS, 'utf8')
  for (const call of [() => llmJson('private fixture', schema, { provider: 'kimi', dataClass: 'pd' }),
    () => llmText('private fixture', { provider: 'codex', dataClass: 'personal' })]) await assert.rejects(call, /not admitted/)
  assert.equal(fs.readFileSync(process.env.FIXTURE_CALLS, 'utf8'), before, 'denied primary cannot dispatch even a fallback')
  const web = { provider: 'kimi', dataClass: 'text', capabilities: ['web_search'] }
  await llmJson('fixture only', schema, web)
  assert.equal(web.provider_used, 'codex')
  assert.equal(web.attempts[0].reason, 'capability_or_tier')
  process.env.MNEMAZINE_CLI_COOLDOWNS = path.join(tmp, 'nonquota')
  process.env.FIXTURE_MODE = 'bad'
  const malformed = { provider: 'claude', dataClass: 'text' }
  await llmJson('fixture', schema, malformed)
  assert.equal(malformed.provider_used, 'kimi', 'non-quota fallback remains supported')
  assert.equal(readCooldown('claude'), null)
  process.env.FIXTURE_MODE = 'timeout'
  const timing = { provider: 'claude', dataClass: 'text', totalTimeoutMs: 80 }
  const start = Date.now()
  await assert.rejects(() => llmJson('fixture', schema, timing))
  assert(Date.now() - start < 3000)
  assert.equal(timing.attempts.length, 1, 'budget prevents another provider call')
  assert.equal(classifyProcessFailure({ status: 0, stdout: 'quota exceeded' }), null)
  assert.equal(classifyProcessFailure({ status: 1, stderr: 'insufficient permissions' }), 'process_error')
  assert.equal(classifyProcessFailure({ status: 1, stderr: 'HTTP 429 too many requests' }), 'rate_limit')
  const dir = path.join(tmp, 'durable')
  recordCooldown('example', 'quota', { dir, now: 1000 })
  recordCooldown('example', 'rate_limit', { dir, now: 2000 })
  assert.equal(readCooldown('example', { dir, now: 3000 }).reason, 'quota', 'shorter concurrent record cannot downgrade cooldown')
  assert.equal(readCooldown('example', { dir, now: 100000000 }), null)
  const weird = path.join(tmp, 'binary with spaces;$(touch unsafe)')
  fs.writeFileSync(weird, mock, { mode: 0o700 })
  assert.equal(resolveExecutable(weird), weird)
  assert.equal(resolveExecutable('$(touch should-not-exist)', { env: { PATH: tmp }, home: tmp }), null)
  fs.writeFileSync(path.join(tmp, 'gemini'), mock, { mode: 0o700 })
  const listed = discoverProviders({ env: { ...process.env, PATH: tmp }, home: tmp })
  assert(listed.some(item => item.name === 'gemini' && item.installed && !item.supported))
  assert(!JSON.stringify(listed).includes('private-token-fixture'))
  assert.equal(fs.readFileSync(process.env.FIXTURE_CALLS, 'utf8').includes('gemini'), false, 'discovery executes no CLI')
  console.log('CLI failover: admission, quota, shared cooldown, capabilities, deadline, safe discovery passed')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
  fs.rmSync(tmp, { recursive: true, force: true })
}
