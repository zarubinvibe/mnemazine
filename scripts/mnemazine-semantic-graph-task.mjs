#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const REFRESH = path.join(ROOT, 'scripts/mnemazine-refresh-graphify.mjs')
const SWARM = path.join(ROOT, 'scripts/mnemazine-semantic-swarm.mjs')
const MERGE = path.join(ROOT, 'scripts/mnemazine-merge-semantic-shards.mjs')
const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const TASK_TIMEOUT_MS = Number(process.env.MNEMAZINE_SEMANTIC_TASK_TIMEOUT_SECONDS || '7200') * 1000
const CLUSTER_TIMEOUT_MS = Number(process.env.MNEMAZINE_SEMANTIC_CLUSTER_TIMEOUT_SECONDS || '900') * 1000
const DEFAULT_STALE_HOURS = Number(process.env.MNEMAZINE_SEMANTIC_MONITOR_STALE_HOURS || '3')

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function taskFile(stateDir = STATE) {
  return path.join(stateDir, 'semantic-graph-task.json')
}

function logFile(stateDir = STATE) {
  return path.join(stateDir, 'semantic-graph-task.log')
}

async function ensureState(stateDir = STATE) {
  await fs.mkdir(stateDir, { recursive: true })
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function writeTaskState(state, stateDir = STATE) {
  await ensureState(stateDir)
  await fs.writeFile(taskFile(stateDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function pidRunning(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function taskStatus(stateDir = STATE) {
  const state = await readJson(taskFile(stateDir), { status: 'never-run' })
  const running = state.status === 'running' && pidRunning(state.pid)
  const progressFile = state.progress_file || (state.shards_dir ? path.join(state.shards_dir, 'progress.json') : '')
  const progress = progressFile ? await readJson(progressFile, null) : null
  return {
    ...state,
    running,
    progress,
    state_file: taskFile(stateDir),
    log_file: logFile(stateDir)
  }
}

function formatSeconds(value) {
  if (value === null || value === undefined || value === '') return 'n/a'
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a'
  const rounded = Math.round(seconds)
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.round(rounded / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = String(minutes % 60).padStart(2, '0')
  return `${hours}h ${rest}m`
}

function listValue(items) {
  if (!Array.isArray(items) || items.length === 0) return 'none'
  return items.map(item => {
    if (typeof item === 'string') return item
    return item?.file || item?.path || item?.shard || item?.id || JSON.stringify(item)
  }).join(', ')
}

function taskElapsedSeconds(status) {
  const start = Date.parse(status.started_at || '')
  const end = status.running ? Date.now() : Date.parse(status.finished_at || '')
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return (end - start) / 1000
  const progressElapsed = Number(status.progress?.elapsed_seconds)
  return Number.isFinite(progressElapsed) && progressElapsed >= 0 ? progressElapsed : null
}

function ageHoursFromIso(value) {
  const start = Date.parse(value || '')
  if (!Number.isFinite(start)) return null
  return Math.max(0, (Date.now() - start) / 3600000)
}

function prettyStatus(status) {
  const progress = status.progress
  const lines = [
    `Semantic: ${status.status || 'unknown'} | ${status.strategy || 'unknown'} | ${progress?.phase || (status.running ? 'running' : 'idle')}`
  ]
  lines.push(`Task: running ${status.running ? 'yes' : 'no'} | PID ${status.pid || 'n/a'} | elapsed ${formatSeconds(taskElapsedSeconds(status))}`)
  if (progress) {
    const failed = Array.isArray(progress.failed_jobs) ? progress.failed_jobs : []
    const completed = progress.completed_jobs ?? 0
    const total = progress.total_jobs ?? 0
    const remaining = progress.remaining_jobs ?? Math.max(0, Number(total) - Number(completed))
    const skipped = progress.skipped_completed_jobs ?? progress.skipped_jobs ?? 0
    lines.push(`Jobs: ${completed}/${total} done | remaining ${remaining} | skipped ${skipped} | active ${listValue(progress.active_jobs)} | failed ${failed.length} | ETA ${formatSeconds(progress.eta_seconds)}`)
    if (failed.length > 0) lines.push(`First fail: ${listValue(failed.slice(0, 1))}`)
  } else {
    lines.push('Jobs: progress unavailable')
  }
  lines.push(`Vault: ${status.vault || 'unknown'}`)
  lines.push(`Progress: ${status.progress_file || 'n/a'}`)
  lines.push(`Log: ${status.log_file || 'n/a'}`)
  return lines.join('\n')
}

function stripTaskArgs(args, options = {}) {
  const flags = new Set(['--start', '--status', '--monitor', '--worker', '--foreground', '--selftest', '--pretty', '--dry-run'])
  if (!options.keepFresh) flags.add('--fresh')
  flags.add('--resume')
  const valueOptions = new Set(['--mode', '--strategy', '--stale-hours'])
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i]
    if (flags.has(item)) continue
    if (valueOptions.has(item)) {
      i += 1
      continue
    }
    if ([...valueOptions].some(name => item.startsWith(`${name}=`))) continue
    if (item === '--json') continue
    out.push(item)
  }
  return out
}

async function needsUpdateMarker(vault) {
  const file = path.join(vault, 'graphify-out', 'needs_update')
  if (!existsSync(file)) return null
  const stat = await fs.stat(file).catch(() => null)
  return {
    file,
    exists: true,
    content: await fs.readFile(file, 'utf8').catch(() => ''),
    age_hours: stat ? Math.max(0, (Date.now() - stat.mtimeMs) / 3600000) : null
  }
}

function monitorReason(status, marker, staleHours) {
  const elapsedHours = ageHoursFromIso(status.started_at)
  if (status.running) {
    return elapsedHours !== null && elapsedHours >= staleHours
      ? { action: 'wait', reason: 'running-stale-live-pid', elapsed_hours: elapsedHours }
      : { action: 'wait', reason: 'running', elapsed_hours: elapsedHours }
  }
  if (status.status === 'running') return { action: 'start', reason: 'running-dead-pid', elapsed_hours: elapsedHours }
  if (['pending', 'failed'].includes(String(status.status || ''))) return { action: 'start', reason: status.status, elapsed_hours: elapsedHours }
  if (marker?.exists && Number(marker.age_hours) >= staleHours) return { action: 'start', reason: 'needs-update-stale', marker_age_hours: marker.age_hours }
  return { action: 'none', reason: marker?.exists ? 'needs-update-not-stale' : 'clean', marker_age_hours: marker?.age_hours ?? null }
}

function progressDone(progress) {
  if (!progress) return false
  if (progress.phase === 'done') return true
  const total = Number(progress.total_jobs)
  const completed = Number(progress.completed_jobs)
  const failed = Array.isArray(progress.failed_jobs) ? progress.failed_jobs.length : 0
  return Number.isFinite(total) && total >= 0 && completed >= total && failed === 0
}

async function resumeCandidate(vault, stateDir = STATE) {
  const previous = await taskStatus(stateDir)
  if (previous.running) return null
  if (!['running', 'pending', 'failed'].includes(String(previous.status || ''))) return null
  if (previous.vault && path.resolve(previous.vault) !== path.resolve(vault)) return null
  if (!previous.shards_dir || !existsSync(previous.shards_dir)) return null
  if (progressDone(previous.progress)) return null
  return previous
}

function hasOption(args, name) {
  return args.includes(`--${name}`) || args.some(item => item.startsWith(`--${name}=`))
}

function parseJsonOutput(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end < start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

function runRefresh(args, timeoutMs = TASK_TIMEOUT_MS) {
  return runCommand(process.execPath, [REFRESH, ...args], timeoutMs)
}

function runCommand(command, args, timeoutMs = TASK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
  })
}

function addDefault(args, name, value) {
  if (!hasOption(args, name)) args.push(`--${name}`, String(value))
}

async function runSwarm(vault, passthrough) {
  const graph = path.join(vault, 'graphify-out', 'graph.json')
  const needsUpdate = path.join(vault, 'graphify-out', 'needs_update')
  const dryRun = passthrough.includes('--dry-run')
  const swarmArgs = ['--vault', vault, '--graph', graph, ...passthrough]
  addDefault(swarmArgs, 'chunk-size', process.env.MNEMAZINE_SEMANTIC_SWARM_CHUNK_SIZE || '40')
  addDefault(swarmArgs, 'batch-size', process.env.MNEMAZINE_SEMANTIC_SWARM_BATCH_SIZE || '1')
  addDefault(swarmArgs, 'excerpt-chars', process.env.MNEMAZINE_SEMANTIC_EXCERPT_CHARS || '600')
  addDefault(swarmArgs, 'max-tokens', process.env.MNEMAZINE_SEMANTIC_MAX_TOKENS || '360')
  addDefault(swarmArgs, 'concurrency', process.env.MNEMAZINE_SEMANTIC_SWARM_CONCURRENCY || '2')

  const swarm = await runCommand(process.execPath, [SWARM, ...swarmArgs])
  const parsedSwarm = parseJsonOutput(swarm.stdout)
  const steps = { swarm: { ok: swarm.code === 0 && parsedSwarm?.ok !== false, code: swarm.code, timedOut: swarm.timedOut, parsed: parsedSwarm } }
  if (dryRun || !steps.swarm.ok) {
    return {
      code: dryRun && steps.swarm.ok ? 2 : (swarm.code || 1),
      timedOut: swarm.timedOut,
      stdout: JSON.stringify({ ok: steps.swarm.ok, mode: 'swarm', dry_run: dryRun, semantic_pending_after: true, steps }, null, 2),
      stderr: swarm.stderr
    }
  }

  const merge = await runCommand(process.execPath, [
    MERGE,
    '--vault', vault,
    '--graph', graph,
    '--shards-dir', parsedSwarm.shards_dir,
    '--manifest', parsedSwarm.manifest
  ])
  const parsedMerge = parseJsonOutput(merge.stdout)
  steps.merge = { ok: merge.code === 0 && parsedMerge?.ok !== false, code: merge.code, timedOut: merge.timedOut, parsed: parsedMerge }

  const cluster = steps.merge.ok
    ? await runCommand('graphify', ['cluster-only', vault, '--graph', graph, '--no-viz'], CLUSTER_TIMEOUT_MS)
    : { code: 1, timedOut: false, stdout: '', stderr: 'merge failed; cluster skipped' }
  steps.cluster = { ok: cluster.code === 0 && !cluster.timedOut, code: cluster.code, timedOut: cluster.timedOut, stdout_tail: String(cluster.stdout || '').trim().split('\n').slice(-5).join('\n'), stderr_tail: String(cluster.stderr || '').trim().split('\n').slice(-5).join('\n') }

  const ok = steps.swarm.ok && steps.merge.ok && steps.cluster.ok
  if (ok) await fs.rm(needsUpdate, { force: true }).catch(() => {})
  return {
    code: ok ? 0 : 2,
    timedOut: Boolean(swarm.timedOut || merge.timedOut || cluster.timedOut),
    stdout: JSON.stringify({ ok, mode: 'swarm', vault, graph, semantic_pending_after: !ok, steps }, null, 2),
    stderr: [swarm.stderr, merge.stderr, cluster.stderr].filter(Boolean).join('\n')
  }
}

async function runWorker() {
  const fresh = hasFlag('fresh') || hasFlag('no-resume')
  const passthrough = stripTaskArgs(argv)
  const vault = resolveVault({ cli: arg('vault') })
  const strategy = arg('strategy', process.env.MNEMAZINE_SEMANTIC_TASK_STRATEGY || 'swarm')
  const startedAt = new Date().toISOString()
  let shardsDir = arg('shards-dir', '')
  let resumedFrom = null
  if (strategy !== 'full' && !shardsDir && !fresh) {
    resumedFrom = await resumeCandidate(vault)
    if (resumedFrom) {
      shardsDir = resumedFrom.shards_dir
      passthrough.push('--shards-dir', shardsDir)
    }
  }
  if (strategy !== 'full' && !shardsDir) {
    shardsDir = process.env.MNEMAZINE_SEMANTIC_SHARDS_DIR
      ? path.join(process.env.MNEMAZINE_SEMANTIC_SHARDS_DIR, startedAt.replace(/[:.]/g, '-'))
      : path.join(vault, '.mnemazine/semantic-shards', startedAt.replace(/[:.]/g, '-'))
    passthrough.push('--shards-dir', shardsDir)
  }
  const progressFile = strategy !== 'full' && shardsDir ? path.join(shardsDir, 'progress.json') : null
  const refreshArgs = ['--vault', vault, '--mode', 'semantic', '--json']
  if (!hasOption(passthrough, 'timeout-seconds') && process.env.MNEMAZINE_SEMANTIC_REFRESH_TIMEOUT_SECONDS) refreshArgs.push('--timeout-seconds', process.env.MNEMAZINE_SEMANTIC_REFRESH_TIMEOUT_SECONDS)
  refreshArgs.push(...passthrough)
  await writeTaskState({
    status: 'running',
    pid: process.pid,
    started_at: startedAt,
    vault,
    strategy,
    fresh,
    resume_from: resumedFrom ? {
      status: resumedFrom.status,
      started_at: resumedFrom.started_at || null,
      shards_dir: resumedFrom.shards_dir,
      progress_file: resumedFrom.progress_file || null
    } : null,
    shards_dir: shardsDir || null,
    progress_file: progressFile,
    command: strategy === 'full'
      ? `node scripts/mnemazine-refresh-graphify.mjs ${refreshArgs.join(' ')}`
      : `node scripts/mnemazine-semantic-swarm.mjs --vault ${vault}`,
    log_file: logFile()
  })
  const result = strategy === 'full'
    ? await runRefresh(refreshArgs)
    : await runSwarm(vault, passthrough)
  const parsed = parseJsonOutput(result.stdout)
  const status = result.code === 0 && !result.timedOut && parsed?.ok !== false
    ? 'succeeded'
    : result.code === 2 || parsed?.semantic_pending_after
      ? 'pending'
      : 'failed'
  await fs.writeFile(logFile(), [
    `# Semantic Graph Task ${startedAt}`,
    '',
    `status=${status}`,
    `exit_code=${result.code}`,
    `timed_out=${result.timedOut}`,
    '',
    '## stdout',
    result.stdout.trim(),
    '',
    '## stderr',
    result.stderr.trim(),
    ''
  ].join('\n'), 'utf8')
  await writeTaskState({
    status,
    pid: process.pid,
    running: false,
    strategy,
    fresh,
    resume_from: resumedFrom ? {
      status: resumedFrom.status,
      started_at: resumedFrom.started_at || null,
      shards_dir: resumedFrom.shards_dir,
      progress_file: resumedFrom.progress_file || null
    } : null,
    shards_dir: parsed?.steps?.swarm?.parsed?.shards_dir || shardsDir || null,
    progress_file: parsed?.steps?.swarm?.parsed?.progress || progressFile,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    vault,
    exit_code: result.code,
    timed_out: result.timedOut,
    semantic_pending_after: Boolean(parsed?.semantic_pending_after),
    semantic_status: parsed?.mode || parsed?.semantic_refresh?.status || parsed?.semantic_refresh?.selected?.status || null,
    chosen_model: parsed?.semantic_refresh?.chosen_model || null,
    state_file: taskFile(),
    log_file: logFile()
  })
  process.exit(status === 'failed' ? 1 : 0)
}

async function startTask() {
  const current = await taskStatus()
  if (current.running) {
    console.log(JSON.stringify({ ok: true, started: false, reason: 'already running', task: current }, null, 2))
    return
  }
  console.log(JSON.stringify(await spawnTask(resolveVault({ cli: arg('vault') })), null, 2))
}

async function spawnTask(vault) {
  await ensureState()
  const child = spawn(process.execPath, [SELF, '--worker', ...stripTaskArgs(argv, { keepFresh: true })], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  const state = {
    status: 'running',
    pid: child.pid,
    running: true,
    started_at: new Date().toISOString(),
    vault,
    state_file: taskFile(),
    log_file: logFile(),
    status_command: 'npm run graph:semantic:status'
  }
  await writeTaskState(state)
  return { ok: true, started: true, task: state }
}

async function monitorTask() {
  const vault = resolveVault({ cli: arg('vault') })
  const staleHoursRaw = Number(arg('stale-hours', String(DEFAULT_STALE_HOURS)))
  const staleHours = Number.isFinite(staleHoursRaw) && staleHoursRaw > 0 ? staleHoursRaw : 3
  const status = await taskStatus()
  const marker = await needsUpdateMarker(vault)
  const decision = monitorReason(status, marker, staleHours)
  let start = null
  if (decision.action === 'start' && !hasFlag('dry-run')) {
    const current = await taskStatus()
    if (current.running) {
      start = { ok: true, started: false, reason: 'already running', task: current }
    } else {
      start = await spawnTask(vault)
    }
  }
  const output = {
    ok: decision.action !== 'wait' || decision.reason === 'running',
    monitor: true,
    dry_run: hasFlag('dry-run'),
    stale_hours: staleHours,
    vault,
    marker,
    status,
    decision,
    start
  }
  if (hasFlag('pretty')) {
    console.log(`Semantic monitor: ${decision.action} (${decision.reason})`)
    console.log(`Vault: ${vault}`)
    console.log(`Task: ${status.status || 'unknown'} | running ${status.running ? 'yes' : 'no'} | PID ${status.pid || 'n/a'}`)
    if (marker?.exists) console.log(`Marker: ${marker.file} | age ${formatSeconds((marker.age_hours || 0) * 3600)}`)
    if (start?.started) console.log(`Started: PID ${start.task.pid}`)
  } else {
    console.log(JSON.stringify(output, null, 2))
  }
  if (!output.ok) process.exit(2)
}

async function selftest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-semantic-task-'))
  await writeTaskState({ status: 'running', pid: 999999, started_at: '2099-01-01T00:00:00.000Z' }, temp)
  const status = await taskStatus(temp)
  if (status.running) throw new Error('selftest failed: dead pid reported running')
  if (!status.state_file.endsWith('semantic-graph-task.json')) throw new Error('selftest failed: state file mismatch')
  const resumeTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-semantic-resume-'))
  const resumeVault = path.join(resumeTemp, 'vault')
  const resumeShards = path.join(resumeVault, '.mnemazine/semantic-shards/old')
  await fs.mkdir(resumeShards, { recursive: true })
  await fs.writeFile(path.join(resumeShards, 'progress.json'), `${JSON.stringify({ phase: 'running', total_jobs: 2, completed_jobs: 1, failed_jobs: [] })}\n`, 'utf8')
  await writeTaskState({ status: 'pending', vault: resumeVault, shards_dir: resumeShards, progress_file: path.join(resumeShards, 'progress.json') }, resumeTemp)
  const candidate = await resumeCandidate(resumeVault, resumeTemp)
  if (candidate?.shards_dir !== resumeShards) throw new Error('selftest failed: resume candidate not selected')
  const pretty = prettyStatus({
    status: 'succeeded',
    strategy: 'swarm',
    running: false,
    pid: 12345,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:01:05.000Z',
    vault: '/tmp/vault',
    progress_file: '/tmp/progress.json',
    log_file: '/tmp/log',
    progress: {
      phase: 'done',
      total_jobs: 2,
      completed_jobs: 1,
      remaining_jobs: 1,
      skipped_completed_jobs: 1,
      active_jobs: [],
      failed_jobs: [],
      eta_seconds: null
    }
  })
  if (!pretty.includes('ETA n/a')) throw new Error('selftest failed: null ETA should render as n/a')
  if (!pretty.includes('remaining 1')) throw new Error('selftest failed: remaining jobs not rendered')
  if (!pretty.includes('skipped 1')) throw new Error('selftest failed: skipped jobs not rendered')
  if (pretty.includes('ETA 0s')) throw new Error('selftest failed: null ETA rendered as 0s')
  if (!pretty.includes('PID 12345')) throw new Error('selftest failed: PID not rendered')
  if (!pretty.includes('elapsed 1m')) throw new Error('selftest failed: elapsed time not rendered')
  if (!prettyStatus({ status: 'never-run', strategy: 'swarm' }).includes('Jobs: progress unavailable')) {
    throw new Error('selftest failed: missing progress fallback not rendered')
  }
  const pendingDecision = monitorReason({ status: 'pending', running: false, started_at: new Date().toISOString() }, null, 3)
  if (pendingDecision.action !== 'start') throw new Error('selftest failed: pending monitor should start')
  const staleLiveDecision = monitorReason({ status: 'running', running: true, started_at: new Date(Date.now() - 4 * 3600000).toISOString() }, null, 3)
  if (staleLiveDecision.action !== 'wait' || staleLiveDecision.reason !== 'running-stale-live-pid') throw new Error('selftest failed: stale live pid should not start duplicate task')
  const markerDecision = monitorReason({ status: 'succeeded', running: false }, { exists: true, age_hours: 4 }, 3)
  if (markerDecision.action !== 'start') throw new Error('selftest failed: stale marker should start')
  await fs.rm(temp, { recursive: true, force: true })
  await fs.rm(resumeTemp, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true }, null, 2))
}

if (hasFlag('selftest')) await selftest()
else if (hasFlag('worker') || hasFlag('foreground')) await runWorker()
else if (hasFlag('status')) {
  const status = await taskStatus()
  console.log(hasFlag('pretty') ? prettyStatus(status) : JSON.stringify(status, null, 2))
}
else if (hasFlag('monitor')) await monitorTask()
else await startTask()
