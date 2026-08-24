#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { graphStats, mergeGraphObjects, readGraph, writeGraph } from './mnemazine-graph-utils.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)
const ROOT = path.resolve(process.cwd())

function arg(name, fallback = '') {
  const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

const VAULT = resolveVault({ cli: arg('vault') })
const GRAPHIFY_OUT = path.join(VAULT, 'graphify-out')
const GRAPH_PATH = path.join(GRAPHIFY_OUT, 'graph.json')
const BACKEND = arg('backend', process.env.MNEMAZINE_GRAPHIFY_BACKEND || 'openai')
const MODEL = arg('model', process.env.MNEMAZINE_GRAPHIFY_MODEL || 'gpt-4.1-mini')
const CHUNK_SIZE = Number(arg('chunk-size', '10'))
const MAX_CONCURRENCY = arg('max-concurrency', '1')
const TIMEOUT_SECONDS = arg('timeout-seconds', '900')
const PENDING_PATH = arg('pending', path.join(GRAPHIFY_OUT, 'semantic-pending-2026-06-18.json'))
const APPLY = hasFlag('apply')
const STOP_ON_QUOTA = !hasFlag('continue-on-quota')
const RUN_ROOT = arg('run-root', path.join(os.tmpdir(), `mnemazine-semantic-shards-${Date.now()}`))

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }))
  })
}

async function keychain(service) {
  const result = await run('security', ['find-generic-password', '-w', '-s', service])
  if (result.code !== 0 || !result.stdout.trim()) return ''
  return result.stdout.trim()
}

// Graph-backend credential map as DATA (env vars + keychain service per backend),
// not a per-provider code branch. New backend = one row here.
// ponytail: graph-backend axis, separate from the CLI-connector registry.
const BACKEND_CREDENTIALS = {
  openai: { env: ['OPENAI_API_KEY'], keychain: 'mnemazine/openai_api_key' },
  kimi: { env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], keychain: 'mnemazine/moonshot_api_key' }
}

async function apiEnv() {
  const spec = BACKEND_CREDENTIALS[BACKEND]
  if (!spec) return {}
  const key = spec.env.map(name => process.env[name]).find(Boolean) || await keychain(spec.keychain)
  return Object.fromEntries(spec.env.map(name => [name, key]))
}

async function walkMarkdown(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith('graphify-out')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walkMarkdown(file))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(file)
  }
  return out
}

function chunks(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function copyFiles(files, fromRoot, toRoot) {
  await fs.rm(toRoot, { recursive: true, force: true })
  for (const file of files) {
    const rel = path.relative(fromRoot, file)
    const target = path.join(toRoot, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(file, target)
  }
}

async function sourceForPending(item, pending) {
  if (Array.isArray(item.source_files) && item.source_files.length) {
    return {
      root: VAULT,
      files: item.source_files.map(rel => path.join(VAULT, rel)).filter(file => existsSync(file))
    }
  }
  const candidates = [
    path.join(pending.run_root || '', 'retry50', item.name || ''),
    path.join(pending.run_root || '', 'retry', item.name || ''),
    path.join(pending.run_root || '', 'shards', item.name || ''),
    path.join(pending.run_root || '', 'shards', item.parent || '')
  ].filter(Boolean)
  const source = candidates.find(candidate => existsSync(candidate))
  if (!source) return { root: VAULT, files: [] }
  return { root: source, files: await walkMarkdown(source) }
}

function parseRefresh(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function hasQuotaError(parsed, text) {
  return /insufficient_quota|exceeded your current quota|TPD rate limit|rate_limit_reached|rate limit reached/i.test(`${text || ''} ${JSON.stringify(parsed || {})}`)
}

async function runShard(shardPath, env) {
  const result = await run(process.execPath, [
    path.join(ROOT, 'scripts/mnemazine-refresh-graphify.mjs'),
    '--vault', shardPath,
    '--backend', BACKEND,
    '--model', MODEL,
    '--mode', 'semantic',
    '--max-concurrency', MAX_CONCURRENCY,
    '--allow-partial-semantic', '0',
    '--timeout-seconds', TIMEOUT_SECONDS,
    '--json'
  ], { env })
  const parsed = parseRefresh(result.stdout)
  const ok = result.code === 0 &&
    parsed?.ok === true &&
    parsed?.semantic_pending_after === false &&
    parsed?.semantic_refresh?.invalid_json_warnings === false &&
    parsed?.semantic_refresh?.rate_limited === false
  return {
    ok,
    code: result.code,
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    quota: hasQuotaError(parsed, `${result.stdout}\n${result.stderr}`),
    status: parsed?.semantic_refresh?.status || parsed?.error || (result.code === 0 ? 'unknown' : 'failed')
  }
}

async function realignReport() {
  return run('graphify', ['cluster-only', VAULT, '--graph', GRAPH_PATH, '--no-viz'])
}

async function snapshot(label) {
  const target = path.join(VAULT, 'graphify-out-snapshots', label)
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(GRAPHIFY_OUT, target, { recursive: true })
  return target
}

async function main() {
  if (!existsSync(PENDING_PATH)) throw new Error(`pending manifest not found: ${PENDING_PATH}`)
  if (!existsSync(GRAPH_PATH)) throw new Error(`graph not found: ${GRAPH_PATH}`)
  await fs.mkdir(RUN_ROOT, { recursive: true })
  const pending = JSON.parse(await fs.readFile(PENDING_PATH, 'utf8'))
  const env = await apiEnv()
  if (BACKEND !== 'ollama' && !Object.values(env).some(Boolean)) throw new Error(`missing API key for backend ${BACKEND}`)

  let staged = await readGraph(GRAPH_PATH)
  const accepted = []
  const rejected = []
  let stopped = null
  let order = 0

  for (const item of pending.rejected || []) {
    const source = await sourceForPending(item, pending)
    const files = source.files.sort((a, b) => a.localeCompare(b))
    if (!files.length) {
      rejected.push({ ...item, status: 'source_missing', source_files: [] })
      continue
    }
    const fileGroups = chunks(files, CHUNK_SIZE)
    for (let groupIndex = 0; groupIndex < fileGroups.length; groupIndex += 1) {
      const group = fileGroups[groupIndex]
      const name = `${item.name || item.parent || 'pending'}-c${String(order).padStart(4, '0')}`
      order += 1
      const shardPath = path.join(RUN_ROOT, 'shards', name)
      await copyFiles(group, source.root, shardPath)
      const refresh = await runShard(shardPath, env)
      await fs.writeFile(path.join(RUN_ROOT, `${name}.stdout.json`), refresh.stdout || '{}', 'utf8')
      await fs.writeFile(path.join(RUN_ROOT, `${name}.stderr.txt`), refresh.stderr || '', 'utf8')
      const sourceFiles = group
        .map(file => path.relative(source.root, file))
        .filter(rel => rel && !rel.startsWith('..'))
      if (!refresh.ok) {
        const failed = {
          name,
          parent: item.name || item.parent || null,
          files: group.length,
          status: refresh.quota ? 'insufficient_quota' : refresh.status,
          code: refresh.code,
          source_files: sourceFiles
        }
        rejected.push(failed)
        if (refresh.quota && STOP_ON_QUOTA) {
          stopped = 'insufficient_quota'
          for (const restGroup of fileGroups.slice(groupIndex + 1)) {
            rejected.push({
              name: `${item.name || item.parent || 'pending'}-not-attempted-${String(order).padStart(4, '0')}`,
              parent: item.name || item.parent || null,
              files: restGroup.length,
              status: 'not_attempted',
              code: null,
              source_files: restGroup
                .map(file => path.relative(source.root, file))
                .filter(rel => rel && !rel.startsWith('..'))
            })
            order += 1
          }
          break
        }
        continue
      }
      const shardGraph = await readGraph(path.join(shardPath, 'graphify-out', 'graph.json'))
      const merged = mergeGraphObjects(staged, shardGraph)
      staged = merged.graph
      accepted.push({
        name,
        parent: item.name || item.parent || null,
        files: group.length,
        graph: refresh.parsed.after,
        merge: merged.stats,
        source_files: sourceFiles
      })
    }
    if (stopped) {
      const currentIndex = pending.rejected.indexOf(item)
      for (const rest of pending.rejected.slice(currentIndex + 1)) {
        const restSource = await sourceForPending(rest, pending)
        const restFiles = restSource.files.sort((a, b) => a.localeCompare(b))
        const sourceFiles = restFiles.map(file => path.relative(restSource.root, file)).filter(rel => rel && !rel.startsWith('..'))
        rejected.push({
          ...rest,
          status: rest.status || 'not_attempted',
          files: sourceFiles.length,
          source_files: sourceFiles
        })
      }
      break
    }
  }

  const stagedPath = path.join(RUN_ROOT, 'staged.graph.json')
  await writeGraph(stagedPath, staged)
  let applied = false
  let beforeSnapshot = null
  let reportRefresh = null
  if (APPLY && accepted.length) {
    beforeSnapshot = await snapshot(`semantic-shards-before-apply-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
    await writeGraph(GRAPH_PATH, staged)
    reportRefresh = await realignReport()
    applied = reportRefresh.code === 0
  }

  const nextPending = {
    created_at: new Date().toISOString(),
    reason: stopped || (rejected.length ? 'strict sharded semantic refresh has rejected chunks' : 'complete'),
    backend: BACKEND,
    model: MODEL,
    run_root: RUN_ROOT,
    accepted_chunks: accepted.length,
    accepted_files: accepted.reduce((sum, item) => sum + item.files, 0),
    rejected_chunks: rejected.length,
    rejected_files: rejected.reduce((sum, item) => sum + (Array.isArray(item.source_files) ? item.source_files.length : item.files), 0),
    rejected,
    staged: graphStats(staged)
  }
  await fs.writeFile(PENDING_PATH, `${JSON.stringify(nextPending, null, 2)}\n`, 'utf8')
  if (rejected.length) await fs.writeFile(path.join(GRAPHIFY_OUT, 'needs_update'), `${nextPending.reason}\n`, 'utf8')
  else await fs.rm(path.join(GRAPHIFY_OUT, 'needs_update'), { force: true }).catch(() => {})

  const output = {
    ok: !rejected.length,
    applied,
    before_snapshot: beforeSnapshot,
    pending: PENDING_PATH,
    staged_graph: stagedPath,
    report_refresh: reportRefresh ? { code: reportRefresh.code, stderr_tail: reportRefresh.stderr.slice(-1200) } : null,
    accepted_chunks: accepted.length,
    accepted_files: nextPending.accepted_files,
    rejected_chunks: rejected.length,
    rejected_files: nextPending.rejected_files,
    stopped,
    graph: graphStats(applied ? await readGraph(GRAPH_PATH) : staged)
  }
  console.log(JSON.stringify(output, null, 2))
  process.exit(rejected.length ? 2 : 0)
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
