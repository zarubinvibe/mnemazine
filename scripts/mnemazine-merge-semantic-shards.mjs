#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readGraph, writeGraph, mergeGraphObjects, graphStats } from './mnemazine-graph-utils.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function edgeKey(graph) {
  return Array.isArray(graph.links) ? 'links' : Array.isArray(graph.edges) ? 'edges' : 'links'
}

function flag(name) {
  return argv.includes(`--${name}`)
}

function sourceFiles(graph) {
  return new Set((graph.nodes || []).map(node => node.source_file).filter(Boolean))
}

function withoutSourceFiles(graph, files) {
  const key = edgeKey(graph)
  const removed = new Set((graph.nodes || [])
    .filter(node =>
      files.has(node.source_file) &&
      (/^[0-9a-f]{8}-/.test(String(node.id || '')) || ['concept', 'rationale'].includes(String(node.file_type || '')))
    )
    .map(node => node.id))
  if (!removed.size) return graph
  return {
    ...graph,
    nodes: (graph.nodes || []).filter(node => !removed.has(node.id)),
    [key]: (graph[key] || []).filter(edge =>
      !files.has(edge.source_file) &&
      !removed.has(edge.source) &&
      !removed.has(edge.target) &&
      !(Array.isArray(edge.nodes) && edge.nodes.some(node => removed.has(node)))
    )
  }
}

async function main() {
  const vault = resolveVault({ cli: arg('vault') })
  const graphPath = path.resolve(arg('graph', path.join(vault, 'graphify-out/graph.json')))
  const shardsDir = path.resolve(arg('shards-dir', process.env.MNEMAZINE_SEMANTIC_SHARDS_DIR || path.join(vault, '.mnemazine/semantic-shards')))
  const manifestPath = arg('manifest', '')
  const noBackup = flag('no-backup')
  if (!existsSync(graphPath)) throw new Error(`graph not found: ${graphPath}`)
  if (!existsSync(shardsDir)) throw new Error(`shards dir not found: ${shardsDir}`)

  let base = await readGraph(graphPath)
  const before = graphStats(base)
  let shardFiles
  if (manifestPath) {
    const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'))
    shardFiles = (manifest.jobs || []).map(job => path.resolve(job.graph || job.shardGraph)).sort()
  } else {
    shardFiles = (await fs.readdir(shardsDir))
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => path.join(shardsDir, name))
  }

  const merged = []
  for (const shardFile of shardFiles) {
    if (!existsSync(shardFile)) throw new Error(`manifest shard missing: ${shardFile}`)
    const shard = await readGraph(shardFile)
    const files = sourceFiles(shard)
    if (!files.size) continue
    base = withoutSourceFiles(base, files)
    base = mergeGraphObjects(base, shard).graph
    merged.push({ shard: path.basename(shardFile), files: files.size, ...graphStats(shard) })
  }

  if (!noBackup) {
    const backup = `${graphPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fs.copyFile(graphPath, backup)
  }
  await writeGraph(graphPath, base)
  console.log(JSON.stringify({
    ok: true,
    graph: graphPath,
    shards_dir: shardsDir,
    before,
    after: graphStats(base),
    merged
  }, null, 2))
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
