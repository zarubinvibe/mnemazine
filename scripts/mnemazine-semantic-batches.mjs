#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readGraph, writeGraph, mergeGraphObjects, graphStats } from './mnemazine-graph-utils.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const CONFIG_PATH = path.join(ROOT, 'config', 'graphify-refresh.json')
const CONFIG = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function flag(name) {
  return argv.includes(`--${name}`)
}

const VAULT = resolveVault({ cli: arg('vault') })
const GRAPH = path.resolve(arg('graph', path.join(VAULT, 'graphify-out/graph.json')))
const BACKEND = arg('backend', process.env.MNEMAZINE_GRAPHIFY_BACKEND || CONFIG.backend || 'ollama')
const MODEL = arg('model', process.env.MNEMAZINE_GRAPHIFY_MODEL || CONFIG.model || 'qwen2.5-coder:7b')
const BATCH_SIZE = Math.max(1, Number(arg('batch-size', process.env.MNEMAZINE_SEMANTIC_BATCH_SIZE || '5')))
const START = Math.max(0, Number(arg('start', '0')))
const LIMIT = Number(arg('limit', '0'))
const EXCERPT_CHARS = Math.max(300, Number(arg('excerpt-chars', process.env.MNEMAZINE_SEMANTIC_EXCERPT_CHARS || '900')))
const MAX_TOKENS = Math.max(120, Number(arg('max-tokens', process.env.MNEMAZINE_SEMANTIC_MAX_TOKENS || '360')))
const CACHE_DIR = path.resolve(arg('cache-dir', process.env.MNEMAZINE_SEMANTIC_CACHE_DIR || path.join(VAULT, '.mnemazine/semantic-cache')))
const USE_CACHE = !flag('no-cache')
const DRY_RUN = flag('dry-run')
const CLUSTER_ONLY = !flag('no-cluster')
const CACHE_VERSION = 1

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (item.name.startsWith('graphify-out')) continue
    const file = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...await walk(file))
    else if (item.isFile() && item.name.endsWith('.md')) out.push(file)
  }
  return out
}

function stripFence(text) {
  return String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
}

function slug(value) {
  return String(value || 'node')
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'node'
}

function edgeKey(graph) {
  return Array.isArray(graph.links) ? 'links' : Array.isArray(graph.edges) ? 'edges' : 'links'
}

function withoutSourceFile(graph, rel) {
  const key = edgeKey(graph)
  const removed = new Set((graph.nodes || [])
    .filter(node => node.source_file === rel && /^[0-9a-f]{8}-/.test(String(node.id || '')))
    .map(node => node.id))
  if (!removed.size) return graph
  return {
    ...graph,
    nodes: (graph.nodes || []).filter(node => !removed.has(node.id)),
    [key]: (graph[key] || []).filter(edge =>
      edge.source_file !== rel &&
      !removed.has(edge.source) &&
      !removed.has(edge.target) &&
      !(Array.isArray(edge.nodes) && edge.nodes.some(node => removed.has(node)))
    )
  }
}

function excerpt(text) {
  return String(text || '')
    .replace(/\n## Справка[\s\S]*$/, '')
    .slice(0, EXCERPT_CHARS)
}

async function ollamaJson(noteText) {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `Extract 3-5 durable concept nodes and 2-4 relationships from this note. Return ONLY JSON: {"nodes":[{"id":"short-id","label":"Label"}],"edges":[{"source":"id","target":"id","relation":"relates_to"}]}.\n\nNote:\n${noteText}`
    }]
  }
  const res = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`ollama http ${res.status}`)
  const json = await res.json()
  return JSON.parse(stripFence(json.choices?.[0]?.message?.content || ''))
}

async function extractFile(file) {
  const rel = path.relative(VAULT, file)
  const raw = await fs.readFile(file, 'utf8')
  const text = excerpt(raw)
  const cache = cachePath(rel, raw)
  if (USE_CACHE) {
    const cached = await readCache(cache)
    if (cached) return { rel, graph: cached.graph, cached: true, cache }
  }
  const parsed = BACKEND === 'ollama'
    ? await ollamaJson(text)
    : (() => { throw new Error(`unsupported backend ${BACKEND}`) })()
  const prefix = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 8)
  const idMap = new Map()
  const nodes = (parsed.nodes || []).slice(0, 8).map(node => {
    const local = slug(node.id || node.label)
    const id = `${prefix}-${local}`
    idMap.set(String(node.id || node.label), id)
    return {
      id,
      label: String(node.label || node.id || local),
      file_type: 'concept',
      source_file: rel
    }
  })
  const links = (parsed.edges || []).slice(0, 12)
    .map(edge => ({
      source: idMap.get(String(edge.source)) || `${prefix}-${slug(edge.source)}`,
      target: idMap.get(String(edge.target)) || `${prefix}-${slug(edge.target)}`,
      relation: String(edge.relation || 'relates_to'),
      type: 'INFERRED',
      confidence: 'INFERRED',
      source_file: rel
    }))
    .filter(edge => edge.source && edge.target && edge.source !== edge.target)
  const graph = { nodes, links }
  if (USE_CACHE) await writeCache(cache, { rel, graph })
  return { rel, graph, cached: false, cache }
}

function cachePath(rel, rawText) {
  const key = crypto.createHash('sha256').update(JSON.stringify({
    version: CACHE_VERSION,
    rel,
    backend: BACKEND,
    model: MODEL,
    excerpt_chars: EXCERPT_CHARS,
    max_tokens: MAX_TOKENS,
    text_sha256: crypto.createHash('sha256').update(rawText).digest('hex')
  })).digest('hex')
  return path.join(CACHE_DIR, `${key}.json`)
}

async function readCache(file) {
  if (!existsSync(file)) return null
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'))
    return cached?.graph?.nodes && cached?.graph?.links ? cached : null
  } catch {
    return null
  }
}

async function writeCache(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify({
    version: CACHE_VERSION,
    backend: BACKEND,
    model: MODEL,
    excerpt_chars: EXCERPT_CHARS,
    max_tokens: MAX_TOKENS,
    created_at: new Date().toISOString(),
    ...value
  }, null, 2)}\n`, 'utf8')
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }))
  })
}

async function main() {
  const files = (await walk(VAULT)).sort()
  const selected = files.slice(START, LIMIT ? START + LIMIT : undefined)
  const plan = {
    vault: VAULT,
    graph: GRAPH,
    backend: BACKEND,
    model: MODEL,
    files: files.length,
    selected: selected.length,
    start: START,
    batch_size: BATCH_SIZE,
    excerpt_chars: EXCERPT_CHARS,
    max_tokens: MAX_TOKENS,
    cache_dir: CACHE_DIR,
    cache: USE_CACHE
  }
  if (DRY_RUN) {
    console.log(JSON.stringify({ ok: true, dry_run: true, ...plan }, null, 2))
    return
  }

  let base = await readGraph(GRAPH)
  const before = graphStats(base)
  const batches = []
  for (let i = 0; i < selected.length; i += BATCH_SIZE) {
    const chunk = selected.slice(i, i + BATCH_SIZE)
    const batch = { index: Math.floor(i / BATCH_SIZE) + 1, start: START + i + 1, end: START + i + chunk.length, results: [] }
    for (const file of chunk) {
      const extracted = await extractFile(file)
      base = withoutSourceFile(base, extracted.rel)
      const merged = mergeGraphObjects(base, extracted.graph)
      base = merged.graph
      batch.results.push({
        file: extracted.rel,
        nodes: extracted.graph.nodes.length,
        edges: extracted.graph.links.length,
        cached: extracted.cached,
        cache: extracted.cache
      })
    }
    await writeGraph(GRAPH, base)
    batches.push(batch)
    console.error(JSON.stringify({ batch: batch.index, start: batch.start, end: batch.end, files: batch.results.length }))
  }

  let cluster = null
  if (CLUSTER_ONLY) {
    cluster = await run('graphify', ['cluster-only', VAULT, '--graph', GRAPH, '--no-viz'])
    if (cluster.code !== 0) throw new Error(`graphify cluster-only failed: ${cluster.stderr || cluster.stdout}`)
  }

  console.log(JSON.stringify({
    ok: true,
    ...plan,
    before,
    after: graphStats(await readGraph(GRAPH)),
    batches,
    cluster: cluster ? { code: cluster.code, stdout_tail: cluster.stdout.trim().split('\n').slice(-3).join('\n') } : null
  }, null, 2))
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
