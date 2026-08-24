#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const EXPECTED_AGENT_CALLS = 25

function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? '' : argv[i + 1] || ''
}

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'))
}

function frontmatterModel(text) {
  const head = String(text || '').match(/^---\n([\s\S]*?)\n---/)
  if (!head) return ''
  return (head[1].match(/^model:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1] || '').trim()
}

async function roleModels() {
  const dir = path.join(ROOT, 'agents/mnemazina-pipeline')
  const out = {}
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.md')) continue
    out[name.replace(/\.md$/, '')] = frontmatterModel(await fs.readFile(path.join(dir, name), 'utf8'))
  }
  return out
}

function isIdent(ch) {
  return /[A-Za-z0-9_$]/.test(ch || '')
}

function skipString(src, i) {
  const quote = src[i]
  i += 1
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === quote) return i + 1
    i += 1
  }
  return i
}

function extractAgentCalls(src) {
  const calls = []
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith('//', i)) { const n = src.indexOf('\n', i + 2); i = n === -1 ? src.length : n; continue }
    if (src.startsWith('/*', i)) { const n = src.indexOf('*/', i + 2); i = n === -1 ? src.length : n + 1; continue }
    if (src[i] === '"' || src[i] === "'" || src[i] === '`') { i = skipString(src, i) - 1; continue }
    if (!src.startsWith('agent(', i) || isIdent(src[i - 1])) continue
    let depth = 0
    for (let j = i; j < src.length; j++) {
      if (src.startsWith('//', j)) { const n = src.indexOf('\n', j + 2); j = n === -1 ? src.length : n; continue }
      if (src.startsWith('/*', j)) { const n = src.indexOf('*/', j + 2); j = n === -1 ? src.length : n + 1; continue }
      if (src[j] === '"' || src[j] === "'" || src[j] === '`') { j = skipString(src, j) - 1; continue }
      if (src[j] === '(') depth += 1
      if (src[j] === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push({ start: i, body: src.slice(i, j + 1) })
          i = j
          break
        }
      }
    }
  }
  return calls
}

function stringValuesFor(name, body) {
  const re = new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`, 'g')
  const out = []
  for (let m; (m = re.exec(body));) out.push(m[1])
  return out
}

function labelOf(body) {
  return stringValuesFor('label', body)[0] || ''
}

function agentTypeOf(body) {
  return stringValuesFor('agentType', body)[0] || ''
}

function hasModel(body) {
  return /\bmodel\s*:/.test(body)
}

function arithmeticHits(calls) {
  const patterns = [
    ['shasum', /\bshasum\b/],
    ['wc -l', /\bwc\s+-l\b/],
    ['| sort', /\|\s*sort\b/],
    ['--json', /(^|[\s"'])--json\b/],
    ['%-threshold', /(?:[0-9]|≥|<=|>=|>|<)\s*[0-9]*\s*%/]
  ]
  const hits = []
  for (const call of calls) {
    for (const [name, re] of patterns) {
      if (re.test(call.body)) hits.push({ label: labelOf(call.body), pattern: name })
    }
  }
  return hits
}

async function checkRunObservability(stateDir) {
  if (!stateDir) return []
  const file = path.join(stateDir, 'run-observability.jsonl')
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  const violations = []
  for (const [idx, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { violations.push(`observability:${idx + 1}: invalid json`); continue }
    if (row.tier === 0 && row.deep === true) violations.push(`observability:${idx + 1}: tier 0 deep=true (${row.file || ''})`)
    if (row.llm_extract_used === true && row.sidecar_present === true) violations.push(`observability:${idx + 1}: llm_extract_used with sidecar (${row.file || ''})`)
  }
  return violations
}

async function main() {
  const policy = await readJson('config/model-policy.json')
  const workflow = await fs.readFile(path.join(ROOT, 'workflows/mnemazina-pipeline.js'), 'utf8')
  const roles = await roleModels()
  const calls = extractAgentCalls(workflow)
  const violations = []

  if (calls.length === 0 || Object.keys(roles).length === 0) {
    const result = { ok: false, code: 2, agent_calls: calls.length, roles: Object.keys(roles).length, violations: ['empty agent or role sample'] }
    if (jsonMode) console.log(JSON.stringify(result, null, 2))
    else console.error(result.violations.join('\n'))
    process.exit(2)
  }

  for (const call of calls) {
    if (hasModel(call.body)) continue
    const type = agentTypeOf(call.body)
    if (!type || !existsSync(path.join(ROOT, 'agents/mnemazina-pipeline', `${type}.md`)) || !roles[type]) {
      violations.push(`agent without model and role model: ${labelOf(call.body) || `offset ${call.start}`}`)
    }
  }

  for (const tier of ['0', '1', '2', '3']) {
    if (!policy.tiers || !policy.tiers[tier]) violations.push(`policy tiers missing ${tier}`)
  }
  for (const role of ['kb-find', 'store', 'reconcile', 'reconcile-2', 'proc']) {
    if (!policy.roles || !policy.roles[role]) violations.push(`policy roles missing ${role}`)
  }
  for (const role of stringValuesFor('label', workflow).filter(v => ['kb-find', 'store', 'reconcile', 'reconcile-2'].includes(v))) {
    if (!workflow.includes(`modelForRole('${role}'`)) violations.push(`role ${role} is not pinned through policy`)
  }
  if (!workflow.includes("modelForRole('proc'")) violations.push('proc is not pinned through policy')

  for (const hit of arithmeticHits(calls)) violations.push(`agent arithmetic ${hit.pattern}: ${hit.label || 'unlabeled'}`)
  violations.push(...await checkRunObservability(arg('run')))

  const result = { ok: violations.length === 0, agent_calls: calls.length, roles: Object.keys(roles).length, violations }
  if (calls.length !== EXPECTED_AGENT_CALLS) {
    violations.push(`agent call count expected ${EXPECTED_AGENT_CALLS}, got ${calls.length}`)
    result.ok = false
    result.violations = violations
  }
  if (jsonMode) console.log(JSON.stringify(result, null, 2))
  else if (violations.length) console.error(violations.join('\n'))
  else console.log('model-pin ok')
  process.exit(violations.length ? 1 : 0)
}

main().catch(err => {
  const message = err && err.message ? err.message : String(err)
  if (jsonMode) console.log(JSON.stringify({ ok: false, code: 1, violations: [message] }, null, 2))
  else console.error(message)
  process.exit(1)
})
