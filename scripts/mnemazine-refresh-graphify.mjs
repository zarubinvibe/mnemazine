#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { graphStats as normalizedGraphStats, mergeGraphObjects, readGraph, writeGraph } from './mnemazine-graph-utils.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

const ROOT = path.resolve(process.cwd())
const CONFIG_PATH = path.join(ROOT, 'config', 'graphify-refresh.json')
const CONFIG = existsSync(CONFIG_PATH)
  ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  : {}
const VAULT = resolveVault({ cli: arg('vault') })
const MODE = arg('mode', 'auto')
const BACKEND = arg('backend', process.env.MNEMAZINE_GRAPHIFY_BACKEND || CONFIG.backend || 'ollama')
const CONFIG_BACKEND = CONFIG.backend || 'ollama'
const CONFIG_MODEL = BACKEND === CONFIG_BACKEND ? CONFIG.model : ''
const MODEL = arg('model', process.env.MNEMAZINE_GRAPHIFY_MODEL || CONFIG_MODEL || '')
const CONFIG_MODELS = Array.isArray(CONFIG.models) ? CONFIG.models.join(',') : ''
const DEFAULT_OLLAMA_LADDER = MODEL ? `${MODEL},gemma2:9b,qwen2.5-coder:7b` : 'qwen:32b,gemma2:9b,qwen2.5-coder:7b'
const MODEL_LADDER = (arg('models', process.env.MNEMAZINE_GRAPHIFY_MODELS || (BACKEND === CONFIG_BACKEND ? CONFIG_MODELS : '') || (BACKEND === 'ollama' ? DEFAULT_OLLAMA_LADDER : MODEL))
  .split(',')
  .map(item => item.trim())
  .filter(Boolean))
const TIMEOUT_MS = Number(arg('timeout-seconds', String(CONFIG.timeout_seconds || '900'))) * 1000
const SMOKE_TIMEOUT_MS = Number(arg('smoke-timeout-seconds', String(CONFIG.smoke_timeout_seconds || '120'))) * 1000
const SHRINK_THRESHOLD = Number(arg('shrink-threshold', String(CONFIG.shrink_threshold || '0.85')))
// Per-backend concurrency default lives in config (data), not a code literal:
// graphify org-concurrency caps map by backend name. New backend = config edit.
const MAX_CONCURRENCY = arg('max-concurrency', process.env.MNEMAZINE_GRAPHIFY_MAX_CONCURRENCY || String(CONFIG.max_concurrency || CONFIG.backend_max_concurrency?.[BACKEND] || ''))
const ALLOW_PARTIAL_SEMANTIC = arg('allow-partial-semantic', process.env.MNEMAZINE_GRAPHIFY_ALLOW_PARTIAL || String(CONFIG.allow_partial_semantic ? 1 : 0)) !== '0'
const MARK_SEMANTIC_PENDING = hasFlag('mark-semantic-pending') || process.env.MNEMAZINE_GRAPHIFY_MARK_SEMANTIC_PENDING === '1'
const JSON_OUT = hasFlag('json')
const GRAPHIFY_OUT = path.join(VAULT, 'graphify-out')
const GRAPH_PATH = path.join(GRAPHIFY_OUT, 'graph.json')
const REPORT_PATH = path.join(GRAPHIFY_OUT, 'GRAPH_REPORT.md')
const ANALYSIS_PATH = path.join(GRAPHIFY_OUT, '.graphify_analysis.json')
const MANIFEST_PATH = path.join(GRAPHIFY_OUT, 'manifest.json')
const NEEDS_UPDATE_PATH = path.join(GRAPHIFY_OUT, 'needs_update')
const EXCLUDED_DIRS = new Set(['.git', '.obsidian'])

function normalizeOllamaBaseUrl(value) {
  const raw = String(value || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '')
  return raw.endsWith('/v1') ? raw : `${raw}/v1`
}

const OLLAMA_BASE_URL = normalizeOllamaBaseUrl(arg('ollama-url', ''))
const API_KEY_ENV_BY_BACKEND = {
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY']
}

function rel(file) {
  return path.relative(VAULT, file) || '.'
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith('graphify-out')) continue
    const p = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...await walk(p))
    else if (item.isFile()) out.push(p)
  }
  return out
}

function isNonCodeFile(file) {
  const ext = path.extname(file).toLowerCase()
  return ['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.gif', '.svg'].includes(ext)
}

async function newestNonCodeMtimeMs() {
  let newest = 0
  for (const file of await walk(VAULT)) {
    if (!isNonCodeFile(file)) continue
    const stat = await fs.stat(file).catch(() => null)
    if (stat) newest = Math.max(newest, stat.mtimeMs)
  }
  return newest
}

async function fileMtimeMs(file) {
  const stat = await fs.stat(file).catch(() => null)
  return stat ? stat.mtimeMs : 0
}

async function graphSummary(graphPath) {
  if (!existsSync(graphPath)) return { exists: false, nodes: 0, edges: 0, communities: 0, mtimeMs: 0 }
  const raw = JSON.parse(await fs.readFile(graphPath, 'utf8'))
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.length : 0
  const links = Array.isArray(raw.links) ? raw.links : Array.isArray(raw.edges) ? raw.edges : []
  const communities = new Set((raw.nodes || []).map(node => node.community).filter(v => v !== undefined && v !== null)).size
  return {
    exists: true,
    nodes,
    edges: links.length,
    communities,
    mtimeMs: await fileMtimeMs(graphPath)
  }
}

function truncate(text, max = 500) {
  const clean = String(text || '').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function stripCodeFence(text) {
  const value = String(text || '').trim()
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : value
}

function hasInvalidJsonWarning(text) {
  return /invalid\s+JSON/i.test(String(text || ''))
}

function hasRateLimitWarning(text) {
  return /rate[_ -]?limit|reached max organization concurrency|429/i.test(String(text || ''))
}

function runCommand(cmd, args, { env = {}, cwd = ROOT, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd,
      // Двоичные файлы python-зависимостей (graphify, graphify-mcp, markitdown) живут в .venv/bin, и туда
      // не смотрит ни один PATH: install.sh симлинкует наружу только bin/mnemazine. Без этой строки
      // `npm run graph:smoke` падал `spawn graphify ENOENT` сразу после чистой установки (issue #6, п.2).
      env: { ...process.env, PATH: `${path.join(ROOT, '.venv', 'bin')}${path.delimiter}${process.env.PATH || ''}`, ...env },
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

async function ensureGraphifyOut() {
  await fs.mkdir(GRAPHIFY_OUT, { recursive: true })
}

async function removeIfExists(target) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {})
}

async function copyDir(from, to) {
  await removeIfExists(to)
  await fs.cp(from, to, { recursive: true })
}

async function restoreBackup(backupDir) {
  if (!existsSync(backupDir)) return
  await removeIfExists(GRAPHIFY_OUT)
  await copyDir(backupDir, GRAPHIFY_OUT)
}

// Keep only the newest GRAPHIFY_BACKUPS_KEEP graphify-out-backup-* dirs.
// Names are ISO timestamps, so lexical sort == chronological. Without this the
// backups accumulate forever inside the vault (10 dirs x ~60MB observed).
// ponytail: keep `keep` to allow restore/rollback; tune via env, never 0.
const GRAPHIFY_BACKUPS_KEEP = Math.max(1, Number(process.env.MNEMAZINE_GRAPHIFY_BACKUPS_KEEP || '3'))
async function pruneBackups(keep = GRAPHIFY_BACKUPS_KEEP) {
  const entries = await fs.readdir(VAULT, { withFileTypes: true }).catch(() => [])
  const backups = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('graphify-out-backup-'))
    .map(entry => entry.name)
    .sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    await removeIfExists(path.join(VAULT, name))
  }
}

async function writeNeedsUpdate(reason = 'semantic graph needs update') {
  await ensureGraphifyOut()
  await fs.writeFile(NEEDS_UPDATE_PATH, `${reason}\n`, 'utf8')
}

async function clearNeedsUpdate() {
  await fs.rm(NEEDS_UPDATE_PATH, { force: true }).catch(() => {})
}

async function ollamaSmoke(model) {
  const modelsRes = await fetch(`${OLLAMA_BASE_URL}/models`).catch(err => ({ ok: false, statusText: err.message }))
  if (!modelsRes.ok) {
    return { ok: false, step: 'models', reason: `${modelsRes.status || 'fetch'} ${modelsRes.statusText || 'failed'}` }
  }
  const modelsPayload = await modelsRes.json().catch(() => ({}))
  const names = Array.isArray(modelsPayload.data) ? modelsPayload.data.map(item => item.id || item.name).filter(Boolean) : []
  if (names.length && !names.includes(model)) {
    return { ok: false, step: 'models', reason: `model ${model} not found`, available_models: names.slice(0, 20) }
  }
  const body = {
    model,
    messages: [{ role: 'user', content: 'Return only valid JSON: {"ok":true}' }],
    max_tokens: 20,
    temperature: 0,
    stream: false
  }
  const chatRes = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer local'
    },
    body: JSON.stringify(body)
  }).catch(err => ({ ok: false, statusText: err.message }))
  if (!chatRes.ok) {
    return { ok: false, step: 'chat', reason: `${chatRes.status || 'fetch'} ${chatRes.statusText || 'failed'}` }
  }
  const chat = await chatRes.json().catch(() => null)
  const content = stripCodeFence(chat?.choices?.[0]?.message?.content?.trim() || '')
  try {
    const parsed = JSON.parse(content)
    if (parsed?.ok === true) return { ok: true, step: 'chat' }
    return { ok: false, step: 'chat', reason: 'response parsed but missing ok=true', content: truncate(content, 120) }
  } catch {
    return { ok: false, step: 'chat', reason: 'response not valid JSON', content: truncate(content, 120) }
  }
}

async function graphifyMiniSmoke(model) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-graphify-smoke-'))
  const notePath = path.join(tempRoot, 'smoke.md')
  const smokeNote = `# Graphify Smoke

## What This Is

Local graphify smoke note for semantic extraction.

## Why It Matters

Automation must reject models that break graphify JSON extraction.

## How To Use

Return stable JSON graph fragments for document notes.

## Source

- local smoke fixture

## Verification

- generated for automation
`
  await fs.writeFile(notePath, smokeNote, 'utf8')
  const env = {
    OLLAMA_BASE_URL,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'local'
  }
  const extract = await runCommand('graphify', ['extract', tempRoot, '--backend', 'ollama', '--model', model], {
    cwd: ROOT,
    env,
    timeoutMs: SMOKE_TIMEOUT_MS
  })
  const graphPath = path.join(tempRoot, 'graphify-out', 'graph.json')
  const summary = await graphSummary(graphPath).catch(() => ({ exists: false, nodes: 0, edges: 0, communities: 0, mtimeMs: 0 }))
  const invalidJson = hasInvalidJsonWarning(`${extract.stdout}\n${extract.stderr}`)
  await removeIfExists(tempRoot)
  if (extract.code !== 0 || extract.timedOut || invalidJson || !summary.exists || summary.nodes === 0) {
    return {
      ok: false,
      reason: extract.timedOut ? 'mini_extract_timeout' : invalidJson ? 'mini_extract_invalid_json' : 'mini_extract_failed',
      extract_code: extract.code,
      extract_timed_out: extract.timedOut,
      stdout_tail: truncate(extract.stdout, 600),
      stderr_tail: truncate(extract.stderr, 600),
      graph: summary
    }
  }
  return {
    ok: true,
    graph: summary,
    stdout_tail: truncate(extract.stdout, 600),
    stderr_tail: truncate(extract.stderr, 600)
  }
}

function graphifyExtractArgs(target, backend, model) {
  const args = ['extract', target, '--backend', backend]
  if (model) args.push('--model', model)
  return args
}

function graphifyExtractCommand(target, backend, model) {
  const args = graphifyExtractArgs(target, backend, model)
  if (MAX_CONCURRENCY) {
    return {
      command: 'python3',
      args: [path.join(ROOT, 'scripts/graphify-extract-limited.py'), ...args],
      env: { GRAPHIFY_LLM_MAX_CONCURRENCY: MAX_CONCURRENCY }
    }
  }
  return { command: 'graphify', args, env: {} }
}

function apiKeyStatus(backend) {
  if (backend === 'ollama') return { ok: true, required_env: [] }
  const required = API_KEY_ENV_BY_BACKEND[backend]
  if (!required) return { ok: false, required_env: [], reason: `unsupported backend ${backend}` }
  const found = required.find(name => Boolean(process.env[name]))
  return found
    ? { ok: true, required_env: required, found_env: found }
    : { ok: false, required_env: required, reason: `set one of: ${required.join(', ')}` }
}

async function graphifyBackendMiniSmoke(backend, model) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-graphify-smoke-'))
  const notePath = path.join(tempRoot, 'smoke.md')
  await fs.writeFile(notePath, `# Graphify API Smoke

## What This Is

Semantic extraction smoke for Graphify backend ${backend}.

## Why It Matters

Mnemazine must reject API/backend configs that cannot build a valid graph.

## Source

- local smoke fixture
`, 'utf8')
  const command = graphifyExtractCommand(tempRoot, backend, model)
  const extract = await runCommand(command.command, command.args, {
    cwd: ROOT,
    env: command.env,
    timeoutMs: SMOKE_TIMEOUT_MS
  })
  const graphPath = path.join(tempRoot, 'graphify-out', 'graph.json')
  const summary = await graphSummary(graphPath).catch(() => ({ exists: false, nodes: 0, edges: 0, communities: 0, mtimeMs: 0 }))
  const invalidJson = hasInvalidJsonWarning(`${extract.stdout}\n${extract.stderr}`)
  await removeIfExists(tempRoot)
  if (extract.code !== 0 || extract.timedOut || invalidJson || !summary.exists || summary.nodes === 0) {
    return {
      ok: false,
      reason: extract.timedOut ? 'mini_extract_timeout' : invalidJson ? 'mini_extract_invalid_json' : 'mini_extract_failed',
      extract_code: extract.code,
      extract_timed_out: extract.timedOut,
      stdout_tail: truncate(extract.stdout, 600),
      stderr_tail: truncate(extract.stderr, 600),
      graph: summary
    }
  }
  return {
    ok: true,
    graph: summary,
    stdout_tail: truncate(extract.stdout, 600),
    stderr_tail: truncate(extract.stderr, 600)
  }
}

async function pickSemanticModel() {
  if (BACKEND !== 'ollama') {
    const key = apiKeyStatus(BACKEND)
    if (!key.ok) return { ok: false, status: key.required_env.length ? 'missing_api_key' : 'unsupported_backend', key }
    const mini = await graphifyBackendMiniSmoke(BACKEND, MODEL)
    return mini.ok
      ? { ok: true, model: MODEL || null, attempts: [{ backend: BACKEND, model: MODEL || null, key_env: key.found_env, mini, ok: true }] }
      : { ok: false, status: 'smoke_failed', attempts: [{ backend: BACKEND, model: MODEL || null, key_env: key.found_env, mini, ok: false }] }
  }
  const attempts = []
  for (const model of unique(MODEL_LADDER)) {
    const chat = await ollamaSmoke(model)
    if (!chat.ok) {
      attempts.push({ model, chat, mini: null, ok: false })
      continue
    }
    const mini = await graphifyMiniSmoke(model)
    attempts.push({ model, chat, mini, ok: mini.ok })
    if (mini.ok) return { ok: true, model, attempts }
  }
  return { ok: false, attempts }
}

async function refreshCodeGraph() {
  const result = await runCommand('graphify', ['update', VAULT], { cwd: ROOT })
  return {
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    timedOut: result.timedOut,
    stdout_tail: truncate(result.stdout, 1200),
    stderr_tail: truncate(result.stderr, 1200)
  }
}

async function realignReport() {
  const result = await runCommand('graphify', ['cluster-only', VAULT, '--graph', GRAPH_PATH, '--no-viz'], { cwd: ROOT })
  return {
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    timedOut: result.timedOut,
    stdout_tail: truncate(result.stdout, 1200),
    stderr_tail: truncate(result.stderr, 1200)
  }
}

async function mergeSemanticGraph(semanticGraphPath) {
  const before = await readGraph(GRAPH_PATH)
  const semantic = await readGraph(semanticGraphPath)
  const merged = mergeGraphObjects(before, semantic)
  await writeGraph(GRAPH_PATH, merged.graph)
  return {
    ok: true,
    code: 0,
    timedOut: false,
    stats: merged.stats,
    graph: normalizedGraphStats(merged.graph),
    stdout_tail: '',
    stderr_tail: ''
  }
}

async function semanticRefresh({ baseline }) {
  const backupDir = path.join(VAULT, `graphify-out-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
  await copyDir(GRAPHIFY_OUT, backupDir)
  await pruneBackups()

  const selected = await pickSemanticModel()
  if (!selected.ok) {
    await writeNeedsUpdate()
    return {
      ok: false,
      status: selected.status || 'smoke_failed',
      backup_dir: backupDir,
      selected
    }
  }
  const chosenModel = selected.model

  const manifestBak = existsSync(MANIFEST_PATH) ? `${MANIFEST_PATH}.bak` : null
  if (manifestBak) {
    await removeIfExists(manifestBak)
    await fs.rename(MANIFEST_PATH, manifestBak)
  }

  const env = BACKEND === 'ollama'
    ? {
        OLLAMA_BASE_URL,
        OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'local'
      }
    : {}
  const semanticOut = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-graphify-semantic-'))
  const command = graphifyExtractCommand(VAULT, BACKEND, chosenModel)
  const extract = await runCommand(command.command, [...command.args, '--out', semanticOut], {
    cwd: ROOT,
    env: { ...env, ...command.env }
  })

  const semanticGraphPath = path.join(semanticOut, 'graphify-out', 'graph.json')
  const semanticSummary = await graphSummary(semanticGraphPath).catch(() => ({ exists: false, nodes: 0, edges: 0, communities: 0, mtimeMs: 0 }))
  const merge = extract.code === 0 && !extract.timedOut && semanticSummary.exists && semanticSummary.nodes > 0
    ? await mergeSemanticGraph(semanticGraphPath)
    : { ok: false, code: 1, timedOut: false, stdout_tail: '', stderr_tail: 'semantic graph missing after extract' }
  const summary = await graphSummary(GRAPH_PATH).catch(() => ({ exists: false, nodes: 0, edges: 0, communities: 0, mtimeMs: 0 }))
  const reportRefresh = existsSync(GRAPH_PATH) && merge.ok ? await realignReport() : { ok: false, code: 1, timedOut: false, stdout_tail: '', stderr_tail: merge.stderr_tail || 'graph missing after merge' }
  await removeIfExists(semanticOut)

  const combinedOutput = `${extract.stdout}\n${extract.stderr}`
  const invalidJson = hasInvalidJsonWarning(combinedOutput)
  const rateLimited = hasRateLimitWarning(combinedOutput)
  const severeShrink = baseline.nodes > 0 && summary.nodes < Math.floor(baseline.nodes * SHRINK_THRESHOLD)
  const success = extract.code === 0 &&
    !extract.timedOut &&
    semanticSummary.exists &&
    semanticSummary.nodes > 0 &&
    merge.ok &&
    summary.exists &&
    summary.nodes > 0 &&
    summary.edges > 0 &&
    (!invalidJson || ALLOW_PARTIAL_SEMANTIC) &&
    (!rateLimited || ALLOW_PARTIAL_SEMANTIC) &&
    !severeShrink &&
    reportRefresh.ok

  if (!success) {
    await restoreBackup(backupDir)
    if (manifestBak && existsSync(manifestBak) && !existsSync(MANIFEST_PATH)) {
      await fs.rename(manifestBak, MANIFEST_PATH).catch(() => {})
    }
    await writeNeedsUpdate()
    return {
      ok: false,
      status: extract.timedOut ? 'timeout' : invalidJson ? 'invalid_json' : rateLimited ? 'rate_limited_partial' : severeShrink ? 'unsafe_shrink' : 'extract_failed',
      backup_dir: backupDir,
      selected,
      chosen_model: chosenModel,
      extract_code: extract.code,
      extract_timed_out: extract.timedOut,
      extract_stdout_tail: truncate(extract.stdout, 1800),
      extract_stderr_tail: truncate(extract.stderr, 1800),
      semantic_graph: semanticSummary,
      merge,
      rate_limited: rateLimited,
      invalid_json_warnings: invalidJson,
      partial_allowed: ALLOW_PARTIAL_SEMANTIC,
      attempted_graph: summary,
      baseline,
      report_refresh: reportRefresh
    }
  }

  if (manifestBak) await removeIfExists(manifestBak)
  await clearNeedsUpdate()
  return {
    ok: true,
    status: 'success',
    backup_dir: backupDir,
    selected,
    chosen_model: chosenModel,
    semantic_graph: semanticSummary,
    merge,
    rate_limited: rateLimited,
    invalid_json_warnings: invalidJson,
    partial_allowed: ALLOW_PARTIAL_SEMANTIC,
    graph: summary,
    extract_stdout_tail: truncate(extract.stdout, 1800),
    extract_stderr_tail: truncate(extract.stderr, 1800),
    report_refresh: reportRefresh
  }
}

async function main() {
  if (!['auto', 'code', 'semantic'].includes(MODE)) {
    console.error(`Unknown mode: ${MODE}. Use auto, code, or semantic.`)
    process.exit(1)
  }
  await ensureGraphifyOut()
  const initialBefore = await graphSummary(GRAPH_PATH)
  const semanticPendingBefore = existsSync(NEEDS_UPDATE_PATH) || (await newestNonCodeMtimeMs()) > initialBefore.mtimeMs
  const result = {
    ok: true,
    vault: VAULT,
    mode: MODE,
    config_path: existsSync(CONFIG_PATH) ? CONFIG_PATH : null,
    backend: BACKEND,
    model: MODEL,
    model_ladder: unique(MODEL_LADDER),
    api_key_env: API_KEY_ENV_BY_BACKEND[BACKEND] || null,
    max_concurrency: MAX_CONCURRENCY || null,
    allow_partial_semantic: ALLOW_PARTIAL_SEMANTIC,
    mark_semantic_pending: MARK_SEMANTIC_PENDING,
    ollama_base_url: BACKEND === 'ollama' ? OLLAMA_BASE_URL : null,
    before: initialBefore,
    code_refresh: null,
    semantic_refresh: null,
    after: null,
    semantic_pending_before: semanticPendingBefore,
    semantic_pending_after: null
  }

  result.code_refresh = await refreshCodeGraph()
  if (!result.code_refresh.ok) {
    await writeNeedsUpdate()
    result.ok = false
    result.after = await graphSummary(GRAPH_PATH)
    result.semantic_pending_after = true
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
    else console.log(`Graphify code refresh failed. ${result.code_refresh.stderr_tail || result.code_refresh.stdout_tail}`)
    process.exit(1)
  }

  const afterCode = await graphSummary(GRAPH_PATH)
  const semanticPending = MARK_SEMANTIC_PENDING || result.semantic_pending_before || existsSync(NEEDS_UPDATE_PATH) || (await newestNonCodeMtimeMs()) > afterCode.mtimeMs || MODE === 'semantic'

  if (MODE === 'code' || (MODE === 'auto' && !semanticPending)) {
    if (MODE !== 'semantic' && semanticPending) await writeNeedsUpdate(MARK_SEMANTIC_PENDING
      ? `deferred: code graph refreshed at ${new Date().toISOString()}; run npm run graph:semantic:async`
      : 'semantic graph needs update')
    result.after = await graphSummary(GRAPH_PATH)
    result.semantic_pending_after = existsSync(NEEDS_UPDATE_PATH)
    result.ok = MODE === 'code' ? true : !result.semantic_pending_after
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
    else console.log(result.semantic_pending_after
      ? `Code graph refreshed. Semantic refresh still pending for ${rel(NEEDS_UPDATE_PATH)}.`
      : `Graph refreshed. Nodes=${result.after.nodes} edges=${result.after.edges} communities=${result.after.communities}.`)
    process.exit(MODE === 'code' || !result.semantic_pending_after ? 0 : 2)
  }

  result.semantic_refresh = await semanticRefresh({ baseline: afterCode })
  result.after = await graphSummary(GRAPH_PATH)
  result.semantic_pending_after = existsSync(NEEDS_UPDATE_PATH)
  result.ok = result.semantic_refresh.ok && !result.semantic_pending_after

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) console.log(`Graph semantic refresh ok. Nodes=${result.after.nodes} edges=${result.after.edges} communities=${result.after.communities}.`)
  else console.log(`Graph semantic refresh pending. Reason=${result.semantic_refresh?.status || 'unknown'}. needs_update=1`)

  process.exit(result.ok ? 0 : 2)
}

main().catch(async error => {
  await writeNeedsUpdate().catch(() => {})
  const payload = {
    ok: false,
    vault: VAULT,
    error: error.message,
    mode: MODE
  }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2))
  else console.error(error)
  process.exit(1)
})
