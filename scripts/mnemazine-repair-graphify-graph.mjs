#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  graphStats,
  normalizeGraphObject,
  readGraph,
  writeGraph
} from './mnemazine-graph-utils.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

const graphPath = path.resolve(arg('graph') || path.join(resolveVault({ requireExists: false }), 'graphify-out', 'graph.json'))
const outPath = arg('out', '')
const apply = hasFlag('apply')

async function main() {
  if (!existsSync(graphPath)) throw new Error(`graph not found: ${graphPath}`)
  const beforeGraph = await readGraph(graphPath)
  const before = graphStats(beforeGraph)
  const repaired = normalizeGraphObject(beforeGraph)
  const after = graphStats(repaired.graph)
  const target = apply ? graphPath : path.resolve(outPath || `${graphPath}.repaired`)

  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeGraph(target, repaired.graph)

  const summary = {
    ok: true,
    applied: apply,
    graph: graphPath,
    out: target,
    before,
    after,
    repair: repaired.stats
  }
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
