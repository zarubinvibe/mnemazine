#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const INBOX = process.env.MNEMAZINE_INBOX || path.join(ROOT, 'inbox')
const REPORTS = process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')
const REBUILD = path.join(STATE, 'rebuild')
const JSON_OUT = process.argv.includes('--json')
const STRICT_GRAPH = process.argv.includes('--strict-graph') || process.env.MNEMAZINE_DOCTOR_STRICT_GRAPH === '1'
const FULL_VAULT = process.argv.includes('--full-vault') || process.env.MNEMAZINE_DOCTOR_FULL_VAULT === '1'
const SELFTEST = process.argv.includes('--selftest')
const WATCH = process.argv.includes('--watch')

if (process.argv.includes('--help')) {
  console.log(`mnemazine-doctor.mjs — сводная диагностика: последний прогон, гейты корпуса,
маркеры графа, состояние semantic-задачи, дымовые пробы. Только читает корпус:
последовательность complete / last-run / graph:smoke / release-check ничего в нём не меняет.

Использование: node scripts/mnemazine-doctor.mjs [флаги]
  --json                      результат в JSON
  --strict-graph              маркеры needs_update — failures, а не warnings
  --full-vault                добавить полный аудит корпуса (human-layer + vault-final-audit)
  --watch                     следить за semantic-задачей до её остановки (только human-вывод)
  --watch-interval-seconds N  интервал watch (по умолчанию 10)
  --selftest                  селф-тест во временном каталоге
  --help                      эта справка

Коды возврата: 0 — всё зелёное; 2 — провалов нет, но есть предупреждения; 1 — есть провалы или ошибка.`)
  process.exit(0)
}

// Каждая красная строка несёт команду починки: доктор не только называет провал,
// но и говорит, чем его лечить (приём эталона setup_doctor.py:501-503).
const DOCTOR_FIX = {
  complete: 'npm run complete -- --require-deep',
  'human-layer': 'npm run human-layer:quality',
  'human-layer-full': 'npm run doctor:full',
  'vault-final-audit': 'npm run audit:vault',
  'last-run': 'npm start  # сделай прогон, затем npm run last-run -- --require-ok',
  'graph-smoke': 'npm run graph:smoke',
  'release-check': 'npm run release-check',
  inbox: 'npm start  # обработай входящие, потом повтори проверку'
}
function fixFor(name) {
  return DOCTOR_FIX[name] || 'npm run doctor -- --json  # смотри детали и повтори шаг'
}
function failureLine(name, label) {
  return `${label} — как починить: ${fixFor(name)}`
}

const COMPLETE_NO_DATA_FAILURES = new Set([
  'last run state missing',
  'weekly report missing',
  'action brief missing',
  'weekly report older than newest vault note',
  'action brief older than newest vault note',
  // Свежая установка: потолок спеки — per-machine runtime, на чистом клоне его нет.
  // Ratchet без базы — не провал, а «ещё не прогонял» (см. complete-check spec-ceiling).
  'spec ceiling has no baseline yet'
])

const LAST_RUN_NO_DATA_FAILURES = new Set([
  'last-run.json missing',
  'last-action-brief.md missing',
  'HTML report missing'
])

function arg(name, fallback = '') {
  const hit = process.argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : process.argv[process.argv.indexOf(hit) + 1] || fallback
}

function watchIntervalMs() {
  const seconds = Number(arg('watch-interval-seconds', process.env.MNEMAZINE_DOCTOR_WATCH_INTERVAL_SECONDS || '10'))
  return Math.max(1000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000)
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

function run(name, command, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({
      name,
      ok: code === 0,
      code: code ?? 1,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    }))
    child.on('error', error => resolve({
      name,
      ok: false,
      code: 1,
      stdout: stdout.trim(),
      stderr: `${stderr}\n${error.message}`.trim()
    }))
  })
}

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

function lineFailures(text) {
  const match = String(text || '').match(/^Failures:\s*(.+)$/m)
  return match ? match[1].split(';').map(item => item.trim()).filter(Boolean) : []
}

function onlyKnownNoData(failures, allowed) {
  return failures.length > 0 && failures.every(item => allowed.has(String(item)))
}

function ownerMachine() {
  return existsSync(path.join(REBUILD, 'П01.done.json'))
}

function noDataWarning(result, { ownerOps = ownerMachine() } = {}) {
  if (result.ok) return ''
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n')
  const json = parseJsonObject(text)
  if (result.name === 'complete' && onlyKnownNoData(json?.failures || [], COMPLETE_NO_DATA_FAILURES)) {
    return `complete has no last-run data yet — как починить: ${fixFor('last-run')}`
  }
  const liveFailures = json?.failures || lineFailures(text)
  if (!ownerOps && result.name === 'last-run' && json?.last_run === null && onlyKnownNoData(liveFailures, LAST_RUN_NO_DATA_FAILURES)) {
    return `last run state missing — как починить: ${fixFor('last-run')}`
  }
  return ''
}

async function activeInboxFiles(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(item => item.isFile() && !item.name.startsWith('.'))
    .map(item => item.name)
}

async function latestVisualReport() {
  const reports = []
  for (const item of await fs.readdir(REPORTS, { withFileTypes: true }).catch(() => [])) {
    if (!item.isFile() || !item.name.endsWith('.html') || !item.name.includes('visual-knowledge-report')) continue
    const file = path.join(REPORTS, item.name)
    reports.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs })
  }
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || ''
}

async function graphMarkers(vault) {
  const candidates = [
    path.join(ROOT, 'vault/graphify-out/needs_update'),
    path.join(vault, 'graphify-out/needs_update')
  ]
  const out = []
  for (const file of [...new Set(candidates.map(item => path.resolve(item)))]) {
    const stat = existsSync(file) ? await fs.stat(file) : null
    out.push({
      file,
      exists: existsSync(file),
      content: existsSync(file) ? (await fs.readFile(file, 'utf8')).trim() : '',
      age_days: stat ? (Date.now() - stat.mtimeMs) / 86400000 : null
    })
  }
  return out
}

async function semanticTaskStatus(stateDir = STATE) {
  const file = path.join(stateDir, 'semantic-graph-task.json')
  const state = await readJson(file, { status: 'never-run' })
  let running = false
  if (state.status === 'running' && Number(state.pid) > 0) {
    try {
      process.kill(Number(state.pid), 0)
      running = true
    } catch {
      running = false
    }
  }
  return {
    ...state,
    running,
    state_file: file,
    log_file: path.join(stateDir, 'semantic-graph-task.log')
  }
}

async function semanticTaskPretty(env = {}) {
  return run('semantic-status-pretty', process.execPath, ['scripts/mnemazine-semantic-graph-task.mjs', '--status', '--pretty'], env)
}

function tail(text, lines = 16) {
  return String(text || '').split('\n').slice(-lines).join('\n')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function semanticTaskHumanLines(semanticTask, semanticPretty) {
  if (semanticTask.status === 'never-run') return []
  const lines = [`Semantic task: ${semanticTask.status}${semanticTask.running ? ' (running)' : ''}`]
  if (semanticPretty) {
    lines.push('Semantic task detail:')
    lines.push(semanticPretty?.ok ? semanticPretty.stdout : tail(semanticPretty?.stderr || semanticPretty?.stdout || 'semantic status unavailable'))
  }
  return lines
}

function needsSemanticDetail(semanticTask) {
  return semanticTask.status !== 'never-run' && (
    semanticTask.running ||
    ['pending', 'failed', 'running'].includes(String(semanticTask.status || ''))
  )
}

async function semanticWatchTick(env = {}, stateDir = STATE) {
  const status = await semanticTaskStatus(stateDir)
  const pretty = await semanticTaskPretty(env)
  return {
    status,
    pretty,
    done: !status.running,
    ok: status.status !== 'failed' && !(status.status === 'running' && !status.running),
    lines: [
      `Semantic watch ${new Date().toISOString()}:`,
      pretty.ok ? pretty.stdout : tail(pretty.stderr || pretty.stdout || 'semantic status unavailable')
    ]
  }
}

async function watchSemanticTask(env = {}) {
  const interval = watchIntervalMs()
  console.log(`\nSemantic watch: every ${Math.round(interval / 1000)}s until task stops.`)
  while (true) {
    await sleep(interval)
    const tick = await semanticWatchTick(env)
    console.log('')
    for (const line of tick.lines) console.log(line)
    if (tick.done) return tick.ok
  }
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join('/tmp', 'mnemazine-doctor-'))
  await fs.writeFile(path.join(temp, 'semantic-graph-task.json'), JSON.stringify({
    status: 'running',
    pid: process.pid,
    started_at: new Date(Date.now() - 65000).toISOString(),
    vault: '/tmp/vault',
    strategy: 'swarm'
  }, null, 2), 'utf8')
  const pretty = await semanticTaskPretty({ MNEMAZINE_STATE: temp })
  if (!pretty.ok) throw new Error(`doctor selftest failed: pretty status command failed\n${pretty.stderr || pretty.stdout}`)
  if (!pretty.stdout.includes('Task: running yes')) throw new Error('doctor selftest failed: running detail missing')
  if (!pretty.stdout.includes(`PID ${process.pid}`)) throw new Error('doctor selftest failed: PID missing')
  if (!pretty.stdout.includes('elapsed')) throw new Error('doctor selftest failed: elapsed missing')
  if (!pretty.stdout.includes(`Log: ${path.join(temp, 'semantic-graph-task.log')}`)) throw new Error('doctor selftest failed: log path missing')
  const human = semanticTaskHumanLines({ status: 'running', running: true }, pretty).join('\n')
  if (!human.includes('Semantic task detail:')) throw new Error('doctor selftest failed: detail header missing')
  if (!human.includes('Task: running yes')) throw new Error('doctor selftest failed: pretty block missing from human output')
  const pendingHuman = semanticTaskHumanLines({ status: 'pending', running: false }, pretty).join('\n')
  if (!pendingHuman.includes('Semantic task detail:')) throw new Error('doctor selftest failed: pending detail missing')
  if (!needsSemanticDetail({ status: 'pending', running: false })) throw new Error('doctor selftest failed: pending should need detail')
  if (needsSemanticDetail({ status: 'succeeded', running: false })) throw new Error('doctor selftest failed: succeeded should not need detail')
  if (!noDataWarning({ name: 'complete', ok: false, stdout: JSON.stringify({ failures: ['last run state missing'] }) })) throw new Error('doctor selftest failed: complete no-data not warning')
  if (noDataWarning({ name: 'complete', ok: false, stdout: JSON.stringify({ failures: ['last run state missing', 'vault quality failed'] }) })) throw new Error('doctor selftest failed: complete disease hidden as no-data')
  const noOwnerLastRun = { name: 'last-run', ok: false, stdout: JSON.stringify({ last_run: null, failures: ['last-run.json missing'] }) }
  if (!noDataWarning(noOwnerLastRun, { ownerOps: false })) throw new Error('doctor selftest failed: last-run no-data not warning')
  if (noDataWarning(noOwnerLastRun, { ownerOps: true })) throw new Error('doctor selftest failed: owner last-run no-data hidden as warning')
  const tick = await semanticWatchTick({ MNEMAZINE_STATE: temp }, temp)
  if (tick.done) throw new Error('doctor selftest failed: running watch tick marked done')
  if (!tick.lines.join('\n').includes('Task: running yes')) throw new Error('doctor selftest failed: watch tick missing pretty output')
  await fs.writeFile(path.join(temp, 'semantic-graph-task.json'), JSON.stringify({
    status: 'succeeded',
    pid: process.pid,
    started_at: new Date(Date.now() - 65000).toISOString(),
    finished_at: new Date().toISOString(),
    vault: '/tmp/vault',
    strategy: 'swarm'
  }, null, 2), 'utf8')
  const doneTick = await semanticWatchTick({ MNEMAZINE_STATE: temp }, temp)
  if (!doneTick.done || !doneTick.ok) throw new Error('doctor selftest failed: finished watch tick not ok')
  await fs.rm(temp, { recursive: true, force: true })
  // Утверждение: критичная строка несёт команду починки (три кода бесполезны, если
  // красная строка не говорит, чем лечить).
  const line = failureLine('release-check', 'release-check failed')
  if (!line.includes('как починить')) throw new Error('doctor selftest failed: failure line carries no fix')
  if (!/npm run|npm start/.test(fixFor('release-check'))) throw new Error('doctor selftest failed: fix is not a runnable command')
  if (!/npm/.test(fixFor('unknown-check-name'))) throw new Error('doctor selftest failed: default fix missing')
  console.log(JSON.stringify({ ok: true }, null, 2))
}

async function main() {
  const lastRun = await readJson(path.join(STATE, 'last-run.json'))
  const vault = resolveVault({ env: process.env.MNEMAZINE_VAULT || lastRun?.vault })
  const env = { MNEMAZINE_VAULT: vault }
  const report = await latestVisualReport()
  const since = lastRun?.started_at || ''

  const commands = [
    ['complete', 'npm', ['run', 'complete', '--', '--require-deep']],
    ...(report && since ? [['human-layer', 'npm', ['run', 'human-layer:quality', '--', '--changed-since', since, '--report', path.relative(ROOT, report)]]] : []),
    ...(FULL_VAULT ? [
      ['human-layer-full', 'npm', ['run', 'human-layer:quality', '--', '--vault', vault, '--changed-since', '1', '--notes-only', '--max-failures', '100']],
      ['vault-final-audit', 'npm', ['run', 'audit:vault', '--', '--vault', vault, '--max-failures', '100']]
    ] : []),
    ['last-run', 'npm', ['run', 'last-run', '--', '--json', '--require-ok']],
    ['graph-smoke', 'npm', ['run', 'graph:smoke']],
    ['release-check', 'npm', ['run', 'release-check']]
  ]

  const results = []
  for (const [name, command, args] of commands) results.push(await run(name, command, args, env))
  const inbox = await activeInboxFiles(INBOX)
  const markers = await graphMarkers(vault)
  const semanticTask = await semanticTaskStatus()
  const semanticPretty = needsSemanticDetail(semanticTask) ? await semanticTaskPretty(env) : null
  const noDataWarnings = results.map(item => [item.name, noDataWarning(item)]).filter(([, warning]) => warning)
  const noDataByName = new Map(noDataWarnings)
  const markerWarnings = markers
    .filter(item => item.exists)
    .map(item => `semantic graph pending: ${item.file}${item.age_days !== null ? ` (${item.age_days.toFixed(2)} days)` : ''}; run npm run graph:semantic:monitor`)
  const failures = [
    ...results.filter(item => !item.ok && !noDataByName.has(item.name)).map(item => failureLine(item.name, `${item.name} failed`)),
    ...(inbox.length ? [failureLine('inbox', `inbox not empty: ${inbox.length}`)] : []),
    ...(STRICT_GRAPH ? markerWarnings : [])
  ]
  const warnings = [
    ...noDataWarnings.map(([, warning]) => warning),
    ...(STRICT_GRAPH ? [] : markerWarnings)
  ]

  const output = {
    ok: failures.length === 0,
    failures,
    warnings,
    full_vault: FULL_VAULT,
    vault,
    inbox: inbox.length,
    report: report ? path.relative(ROOT, report) : null,
    graph_markers: markers,
    semantic_graph_task: semanticTask,
    semantic_graph_pretty: semanticPretty?.ok ? semanticPretty.stdout : null,
    commands: results.map(item => ({ name: item.name, ok: item.ok, code: item.code, no_data: noDataByName.has(item.name) }))
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2))
  } else {
    console.log(output.ok ? 'Mnemazine doctor: ok' : 'Mnemazine doctor: failed')
    console.log(`Vault: ${vault}`)
    if (FULL_VAULT) console.log('Full vault audit: enabled')
    console.log(`Inbox: ${inbox.length}`)
    console.log(`Report: ${output.report || 'missing'}`)
    for (const item of results) console.log(`${item.ok ? 'ok' : noDataByName.has(item.name) ? 'warn' : 'fail'} ${item.name}${noDataByName.has(item.name) ? ' (no data)' : ''}`)
    for (const marker of markers) console.log(`${marker.exists ? 'warn' : 'ok'} marker ${marker.file}`)
    for (const line of semanticTaskHumanLines(semanticTask, semanticPretty)) console.log(line)
    if (warnings.length) {
      console.log('\nWarnings:')
      for (const warning of warnings) console.log(`- ${warning}`)
    }
    if (failures.length) {
      console.log('\nFailures:')
      for (const failure of failures) console.log(`- ${failure}`)
      const failed = results.find(item => !item.ok && !noDataByName.has(item.name))
      if (failed) {
        console.log(`\n${failed.name} output:`)
        console.log(tail([failed.stderr, failed.stdout].filter(Boolean).join('\n'), 80))
      }
    }
  }

  if (WATCH && output.ok && semanticTask.running) {
    if (JSON_OUT) console.error('doctor --watch is human-output only; printed one JSON snapshot and skipped watch')
    else if (!await watchSemanticTask(env)) process.exit(1)
  }

  // Три кода вместо двух: провалы → 1; провалов нет, но есть предупреждения → 2; иначе 0.
  if (!output.ok) process.exit(1)
  if (warnings.length) process.exit(2)
}

const entrypoint = SELFTEST ? selftest : main
entrypoint().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
