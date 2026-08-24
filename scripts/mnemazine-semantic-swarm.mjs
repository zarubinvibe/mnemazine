#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function flag(name) {
  return argv.includes(`--${name}`)
}

async function countVaultFiles(vault) {
  let count = 0
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('graphify-out')) continue
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && item.name.endsWith('.md')) count += 1
    }
  }
  await walk(vault)
  return count
}

function runWorker(job) {
  return new Promise(resolve => {
    const args = [
      'scripts/mnemazine-semantic-batches.mjs',
      '--vault', job.vault,
      '--graph', job.graph,
      '--batch-size', String(job.batchSize),
      '--excerpt-chars', String(job.excerptChars),
      '--max-tokens', String(job.maxTokens),
      '--start', String(job.start),
      '--limit', String(job.limit),
      '--no-cluster'
    ]
    if (job.backend) args.push('--backend', job.backend)
    if (job.model) args.push('--model', job.model)
    if (job.cacheDir) args.push('--cache-dir', job.cacheDir)
    if (!job.cache) args.push('--no-cache')
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    const errors = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => {
      errors.push(chunk)
      process.stderr.write(`[${job.name}] ${String(chunk)}`)
    })
    child.on('close', async code => {
      const stdout = Buffer.concat(chunks).toString()
      const stderr = Buffer.concat(errors).toString()
      await fs.writeFile(job.log, stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''), 'utf8')
      resolve({ ...job, code: code ?? 1 })
    })
    child.on('error', async error => {
      await fs.writeFile(job.log, error.message, 'utf8')
      resolve({ ...job, code: 1 })
    })
  })
}

async function main() {
  const vault = resolveVault({ cli: arg('vault') })
  const graph = path.resolve(arg('graph', path.join(vault, 'graphify-out/graph.json')))
  const shardsDir = path.resolve(arg('shards-dir', process.env.MNEMAZINE_SEMANTIC_SHARDS_DIR ? path.join(process.env.MNEMAZINE_SEMANTIC_SHARDS_DIR, RUN_ID) : path.join(vault, `.mnemazine/semantic-shards/${RUN_ID}`)))
  const logsDir = path.resolve(arg('logs-dir', path.join(shardsDir, 'logs')))
  const cacheDir = path.resolve(arg('cache-dir', process.env.MNEMAZINE_SEMANTIC_CACHE_DIR || path.join(vault, '.mnemazine/semantic-cache')))
  const manifestPath = path.join(shardsDir, 'manifest.json')
  const progressPath = path.join(shardsDir, 'progress.json')
  const startedAt = new Date().toISOString()
  const total = await countVaultFiles(vault)
  const start = Math.max(0, Number(arg('start', '0')))
  const limit = Number(arg('limit', String(Math.max(0, total - start))))
  const chunkSize = Math.max(1, Number(arg('chunk-size', '50')))
  const batchSize = Math.max(1, Number(arg('batch-size', '1')))
  const excerptChars = Math.max(300, Number(arg('excerpt-chars', '600')))
  const maxTokens = Math.max(120, Number(arg('max-tokens', '360')))
  const backend = arg('backend', process.env.MNEMAZINE_GRAPHIFY_BACKEND || '')
  const model = arg('model', process.env.MNEMAZINE_GRAPHIFY_MODEL || '')
  const concurrency = Math.max(1, Number(arg('concurrency', String(Math.min(8, Math.max(1, os.cpus().length - 2))))))
  const dryRun = flag('dry-run')
  const resume = !flag('no-resume')
  const cache = !flag('no-cache')
  await fs.mkdir(shardsDir, { recursive: true })
  await fs.mkdir(logsDir, { recursive: true })

  const end = Math.min(total, start + limit)
  const selected = Math.max(0, end - start)
  const hadManifest = existsSync(manifestPath)
  const jobs = []
  for (let i = start; i < end; i += chunkSize) {
    const size = Math.min(chunkSize, end - i)
    const name = `${String(i).padStart(5, '0')}-${String(i + size - 1).padStart(5, '0')}`
    jobs.push({
      name,
      vault,
      graph,
      shardGraph: path.join(shardsDir, `${name}.json`),
      log: path.join(logsDir, `${name}.log`),
      done: path.join(shardsDir, `${name}.done.json`),
      start: i,
      limit: size,
      batchSize,
      excerptChars,
      maxTokens,
      backend,
      model,
      cacheDir,
      cache,
      signature: JSON.stringify({ start: i, limit: size, batchSize, excerptChars, maxTokens, backend, model, cache })
    })
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, vault, graph, shards_dir: shardsDir, manifest: manifestPath, progress: progressPath, cache_dir: cacheDir, cache, resume, total, selected, start, chunk_size: chunkSize, batch_size: batchSize, excerpt_chars: excerptChars, max_tokens: maxTokens, backend: backend || null, model: model || null, concurrency, jobs: jobs.map(j => ({ name: j.name, start: j.start, limit: j.limit, graph: j.shardGraph, done: j.done })) }, null, 2))
    return
  }

  await fs.writeFile(manifestPath, `${JSON.stringify({
    vault,
    graph,
    shards_dir: shardsDir,
    total,
    selected,
    start,
    chunk_size: chunkSize,
    batch_size: batchSize,
    excerpt_chars: excerptChars,
    max_tokens: maxTokens,
    backend: backend || null,
    model: model || null,
    cache_dir: cacheDir,
    cache,
    resume,
    resumed: resume && hadManifest,
    concurrency,
    progress: progressPath,
    jobs: jobs.map(job => ({ name: job.name, start: job.start, limit: job.limit, graph: job.shardGraph, log: job.log, done: job.done, signature: job.signature }))
  }, null, 2)}\n`, 'utf8')

  let next = 0
  const done = []
  const skipped = []
  const active = new Map()
  async function completedJob(job) {
    if (!resume || !await fs.access(job.done).then(() => true).catch(() => false)) return false
    try {
      const marker = JSON.parse(await fs.readFile(job.done, 'utf8'))
      return marker.signature === job.signature && await fs.access(job.shardGraph).then(() => true).catch(() => false)
    } catch {
      return false
    }
  }
  async function writeProgress(phase = 'running') {
    const completed = done.length
    const failed = done.filter(j => j.code !== 0)
    const remaining = Math.max(0, jobs.length - completed)
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
    const eta = completed > 0 && completed < jobs.length
      ? Math.round((elapsed / completed) * (jobs.length - completed))
      : null
    await fs.writeFile(progressPath, `${JSON.stringify({
      ok: failed.length === 0,
      phase,
      vault,
      graph,
      shards_dir: shardsDir,
      manifest: manifestPath,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      elapsed_seconds: elapsed,
      eta_seconds: eta,
      total_jobs: jobs.length,
      completed_jobs: completed,
      remaining_jobs: remaining,
      skipped_jobs: skipped.length,
      skipped_completed_jobs: skipped.length,
      resumed: Boolean(resume && (hadManifest || skipped.length > 0)),
      active_jobs: [...active.values()].map(j => ({ name: j.name, start: j.start, limit: j.limit })),
      failed_jobs: failed.map(j => ({ name: j.name, code: j.code, log: j.log }))
    }, null, 2)}\n`, 'utf8')
  }
  await writeProgress(jobs.length ? 'running' : 'done')

  async function worker(slot) {
    while (next < jobs.length) {
      const job = jobs[next++]
      if (await completedJob(job)) {
        skipped.push(job)
        done.push({ ...job, code: 0, skipped: true })
        process.stderr.write(`[swarm:${slot}] skip ${job.name} (resume)\n`)
        await writeProgress('running')
        continue
      }
      await fs.writeFile(job.shardGraph, '{"nodes":[],"links":[]}\n', 'utf8')
      active.set(job.name, job)
      process.stderr.write(`[swarm:${slot}] start ${job.name}\n`)
      await writeProgress('running')
      const result = await runWorker({ ...job, graph: job.shardGraph })
      active.delete(job.name)
      done.push(result)
      if (result.code === 0) {
        await fs.writeFile(job.done, `${JSON.stringify({
          name: job.name,
          signature: job.signature,
          graph: job.shardGraph,
          log: job.log,
          finished_at: new Date().toISOString()
        }, null, 2)}\n`, 'utf8')
      }
      process.stderr.write(`[swarm:${slot}] done ${job.name} code=${result.code}\n`)
      await writeProgress('running')
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, (_, i) => worker(i + 1)))

  const failed = done.filter(j => j.code !== 0)
  console.log(JSON.stringify({
    ok: failed.length === 0,
    vault,
    graph,
    shards_dir: shardsDir,
    manifest: manifestPath,
    progress: progressPath,
    total,
    selected,
    start,
    chunk_size: chunkSize,
    batch_size: batchSize,
    excerpt_chars: excerptChars,
    max_tokens: maxTokens,
    backend: backend || null,
    model: model || null,
    cache_dir: cacheDir,
    cache,
    resume,
    resumed: Boolean(resume && (hadManifest || skipped.length > 0)),
    concurrency,
    completed: done.length,
    skipped: skipped.length,
    failed: failed.map(j => ({ name: j.name, start: j.start, limit: j.limit, log: j.log }))
  }, null, 2))
  await writeProgress(failed.length ? 'failed' : 'done')
  if (failed.length) process.exit(1)
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
