#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// No default vault path: a fallback here would write one person's layout into
// everyone's install. Say what is missing and stop.
const VAULT = process.env.MNEMAZINE_VAULT
if (!VAULT) {
  console.error('MNEMAZINE_VAULT не задан — укажите путь к своему vault и повторите.')
  process.exit(1)
}
const SYS = join(VAULT, '99 Система')
const OBS_LOG = join(SYS, '_run-observability.jsonl')
const LEDGER = join(SYS, '_session-learning-ledger.jsonl')
const REPORT = join(SYS, '_last-session-review.md')

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.split('=').slice(1).join('=')
  const idx = argv.indexOf(hit)
  return argv[idx + 1] || fallback
}

const RUN_ID = arg('run-id', process.env.MNEMAZINE_RUN_ID || 'unknown')
const RUNTIME = arg('runtime', process.env.MNEMAZINE_RUNTIME || 'unknown')
const TOKEN_JSON = arg('token-json', '')
const RESULT_JSON = arg('result-json', '')

function parseJson(value, fallback = null) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function compact(value, n = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

function numberFromTokens(value) {
  const raw = String(value || '').replace(/[^0-9]/g, '')
  return raw ? Number(raw) : null
}

const tokenUsage = parseJson(TOKEN_JSON, {})
const result = parseJson(RESULT_JSON, {})
const lines = existsSync(OBS_LOG) ? (await readFile(OBS_LOG, 'utf8')).split('\n').filter(Boolean) : []
const samples = lines.map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(row => row && row.run_id === RUN_ID)

const nums = samples.map(row => numberFromTokens(row.tokens)).filter(n => Number.isFinite(n))
const startTokens = tokenUsage.start_tokens ?? (nums.length ? nums[0] : null)
const endTokens = tokenUsage.end_tokens ?? (nums.length ? nums[nums.length - 1] : null)
const deltaTokens = tokenUsage.delta_tokens ?? tokenUsage.total_tokens ?? (
  startTokens != null && endTokens != null ? endTokens - startTokens : null
)

const localRuns = Array.isArray(tokenUsage.local_runs) ? tokenUsage.local_runs : []
const cloudRuns = Array.isArray(tokenUsage.runs) ? tokenUsage.runs : []
const localLabels = new Set(localRuns.map(r => r.label).filter(Boolean))
const cloudLabels = new Set(cloudRuns.map(r => r.label).filter(Boolean))
const localFirstLabels = ['ocr-pass', 'transcribe-pass', 'triage', 'process', 'store', 'hash-record', 'embed-add', 'graphify', 'briefing']
const localFirstViolations = localFirstLabels.filter(label => cloudLabels.has(label) && !localLabels.has(label))

const errors = []
if (result && result.error) errors.push(String(result.error))
if (Array.isArray(result?.unaccounted) && result.unaccounted.length) {
  errors.push(`unaccounted:${result.unaccounted.length}`)
}
if (result && result.balanced === false) errors.push('coverage_not_balanced')
if (localFirstViolations.length) errors.push(`local_first_violations:${localFirstViolations.join(',')}`)
if (deltaTokens != null && deltaTokens > 0 && cloudRuns.length === 0 && RUNTIME.includes('codex')) {
  errors.push('token_delta_without_cloud_runs')
}

const tokenSummary = {
  runtime: RUNTIME,
  run_id: RUN_ID,
  source: tokenUsage.source || (tokenUsage.runtime === 'codex' ? 'codex exec output' : 'abtop'),
  total_tokens: deltaTokens,
  start_tokens: startTokens,
  end_tokens: endTokens,
  samples: tokenUsage.samples ?? samples.length,
  codex_agent_calls: tokenUsage.codex_agent_calls ?? cloudRuns.length,
  local_agent_calls: tokenUsage.local_agent_calls ?? localRuns.length,
  measured_agent_calls: tokenUsage.measured_agent_calls ?? null,
}

const audit = {
  local_first_ok: localFirstViolations.length === 0,
  local_first_violations: localFirstViolations,
  protected_local_engines: ['Apple Vision OCR', 'whisper', 'MarkitDown', 'fastembed', 'Graphify', 'mnemozina-brief'],
  rule: 'OCR/transcribe/parse/dedup/embed/graph/brief must stay local unless user explicitly asks deep LLM synthesis.',
}

const learning = {
  ts: new Date().toISOString(),
  run_id: RUN_ID,
  runtime: RUNTIME,
  token_summary: tokenSummary,
  audit,
  errors,
  lesson: errors.length
    ? `Следующий прогон: сначала проверить ${errors.join('; ')}. Не тратить LLM на локальные стадии.`
    : 'Ошибок хвоста не найдено. Сохранять local-first cascade.',
}

const agentTrace = Array.isArray(result?.agent_trace) ? result.agent_trace : []
const okAgents = agentTrace.filter(a => a && (a.status === 'ok' || a.status === 'repaired')).map(a => a.name).filter(Boolean)
const badAgents = agentTrace.filter(a => a && !['ok', 'repaired'].includes(a.status)).map(a => `${a.name}:${a.status}`).filter(Boolean)
const gates = result?.gates && typeof result.gates === 'object' ? result.gates : {}
const worked = []
if (result?.status === 'done') worked.push('coverage closed with status=done')
if (result?.graph_updated) worked.push('Graphify updated after intake')
if (result?.briefing?.brief_md) worked.push('brief_md returned to chat')
if (audit.local_first_ok) worked.push('local-first audit passed')
if (okAgents.length) worked.push(`agent trace closed: ${okAgents.join(', ')}`)

const failed = []
if (result?.status && result.status !== 'done') failed.push(`status=${result.status}`)
if (Array.isArray(result?.unaccounted) && result.unaccounted.length) failed.push(`unaccounted=${result.unaccounted.length}`)
if (result?.balanced === false) failed.push('ledger not balanced')
if (!result?.graph_updated) failed.push('Graphify not updated or skipped')
if (!result?.briefing?.brief_md) failed.push('brief_md missing')
if (!audit.local_first_ok) failed.push(`local-first violations: ${audit.local_first_violations.join(', ')}`)
if (badAgents.length) failed.push(`agent trace problems: ${badAgents.join(', ')}`)
if (errors.length) failed.push(`errors: ${errors.join('; ')}`)

const mistakes = []
if (failed.length) mistakes.push(...failed)
if (result?.status === 'done' && !errors.length && audit.local_first_ok) {
  mistakes.push('no blocking mistakes detected')
}

const fixes = []
if (Array.isArray(result?.unaccounted) && result.unaccounted.length) fixes.push('rerun only unaccounted files before archive; keep them in inbox')
if (result?.balanced === false) fixes.push('recompute ledger from disk, not agent summary')
if (!audit.local_first_ok) fixes.push('move violated stages back to local engines before next intake')
if (!result?.briefing?.brief_md) fixes.push('run mnemozina-brief and return brief_md in chat')
if (!result?.graph_updated) fixes.push('initialize or repair Graphify before next knowledge run')
if (!fixes.length) fixes.push('keep current contract; next improvement is more precise agent trace metrics')

const selfReflection = {
  worked,
  did_not_work: failed.length ? failed : ['no blocking failures detected'],
  mistakes,
  fixes,
  most_important: failed.length
    ? `Fix first: ${failed[0]}`
    : 'Contract held: keep local-first, named-agent trace, Graphify, brief_md, and session review as non-optional tail.',
  agent_trace: agentTrace,
  gates,
}
learning.self_reflection = selfReflection

await mkdir(SYS, { recursive: true })
await appendFile(LEDGER, JSON.stringify(learning) + '\n')

const md = `---\n` +
  `title: "Session Review"\n` +
  `type: "session-review"\n` +
  `run_id: "${RUN_ID}"\n` +
  `date: "${new Date().toISOString().slice(0, 10)}"\n` +
  `token_usage: ${deltaTokens == null ? 'null' : deltaTokens}\n` +
  `---\n\n` +
  `# Session Review: ${RUN_ID}\n\n` +
  `## Расход токенов\n\n` +
  `- Runtime: ${RUNTIME}\n` +
  `- Total/delta: ${deltaTokens == null ? 'unknown' : deltaTokens}\n` +
  `- Start/end: ${startTokens ?? 'unknown'} / ${endTokens ?? 'unknown'}\n` +
  `- Calls: cloud ${tokenSummary.codex_agent_calls}, local ${tokenSummary.local_agent_calls}\n\n` +
  `## Local-first audit\n\n` +
  `- Status: ${audit.local_first_ok ? 'OK' : 'VIOLATION'}\n` +
  `- Violations: ${localFirstViolations.length ? localFirstViolations.join(', ') : 'none'}\n` +
  `- Protected engines: ${audit.protected_local_engines.join(', ')}\n\n` +
  `## Ошибки и урок\n\n` +
  `- Errors: ${errors.length ? errors.map(compact).join('; ') : 'none'}\n` +
  `- Lesson: ${learning.lesson}\n\n` +
  `## Саморефлексия Мнемозины\n\n` +
  `- Что сработало: ${worked.length ? worked.map(compact).join('; ') : 'none'}\n` +
  `- Что не сработало: ${failed.length ? failed.map(compact).join('; ') : 'no blocking failures detected'}\n` +
  `- Ошибки: ${mistakes.length ? mistakes.map(compact).join('; ') : 'none'}\n` +
  `- Как исправить: ${fixes.length ? fixes.map(compact).join('; ') : 'none'}\n` +
  `- Самое важное: ${selfReflection.most_important}\n`

await writeFile(REPORT, md)
console.log(JSON.stringify({ review_path: REPORT, ledger_path: LEDGER, token_summary: tokenSummary, audit, self_reflection: selfReflection, errors }, null, 2))
