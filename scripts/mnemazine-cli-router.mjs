#!/usr/bin/env node
// Single point of CLI selection: registry (data) → overlay (narrows, never
// widens) → data class → capability → cost tier → availability probe → chain.
// Ported concept from Фемида's cli_router.py (замысел, not code). Adding a new
// CLI is one JSON entry in the registry or overlay and zero code edits here —
// the code branches on declared CAPABILITY, never on a CLI name.
//
// Exit codes: 0 executor chosen · 1 selection refused (broken entry, empty
// registry, class without carrier, capability without carrier, none available)
// · 2 registry physically not read. Every refusal names its cause — never
// "выбрано 0" (the Фемида lesson: an empty selection is an error, not a success).
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { probeCli } from './mnemazine-cli-probe.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REGISTRY = path.join(HERE, '..', 'config', 'cli-registry.json')
export const DEFAULT_OVERLAY = path.join(HERE, '..', 'config', 'cli-registry.local.json')
export const DEFAULT_TAXONOMY = path.join(HERE, '..', 'config', 'data-classes.json')

// Mnemazine data classes (Фемида had one, `pd`). `pd` never leaves the device:
// its chain is a local engine only. The class taxonomy of a NOTE lives in
// config/data-classes.json (П24) — this list is only the router's admission axis.
export const DATA_CLASSES = ['pd', 'personal', 'text', 'public', 'infra']
export const COST_TIERS = ['cheap', 'standard', 'premium']
const COST_RANK = { cheap: 0, standard: 1, premium: 2 }
// Schema mechanisms are three adapters, chosen by capability, never by name.
export const SCHEMA_ADAPTERS = ['json_schema_inline', 'json_schema_file', 'json_in_prompt']
// A base CLI's harness (what makes it that tool) cannot be repinned by the overlay.
const LOCKED_KEYS = ['probe', 'invoke', 'data_classes', 'capabilities', 'local']
const OVERLAY_TWEAKABLE = ['model', 'effort', 'cost_tier']

const ASCII_NAME_RE = /^[a-z0-9._-]+$/
// Cyrillic homoglyphs folded to Latin so "clаude" (Cyrillic а) is caught.
const CONFUSABLES = {
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', н: 'h',
  т: 't', м: 'm', в: 'b', к: 'k', з: '3', ч: '4', и: 'u'
}

// A name folded to the harness canon: NFKD drops diacritics ("cláude"→claude),
// spaces and zero-width (Cf) marks removed, homoglyphs mapped, case dropped.
// Everything a base name can be faked with in a log, and not caught by eye.
function fold(name) {
  const nfkd = name.normalize('NFKD')
  let out = ''
  for (const ch of nfkd) {
    if (/\s/.test(ch)) continue
    const cat = ch.charCodeAt(0)
    // Strip combining marks (already split by NFKD) and zero-width format chars.
    if (/\p{Mn}|\p{Cf}/u.test(ch)) continue
    out += CONFUSABLES[ch] || ch
  }
  return out.toLowerCase()
}

function isDoubleOf(name, baseName) {
  return name !== baseName && fold(name) === fold(baseName)
}

function validateEntry(name, entry) {
  if (!name || typeof name !== 'string' || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw taggedError(1, `${name}: запись реестра должна быть объектом`)
  }
  for (const key of ['probe', 'invoke', 'data_classes', 'capabilities']) {
    const value = entry[key]
    if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === 'string' && v)) {
      throw taggedError(1, `${name}: ${key} должен быть непустым списком непустых строк`)
    }
  }
  for (const key of ['model', 'effort']) {
    if (typeof entry[key] !== 'string' || !entry[key]) throw taggedError(1, `${name}: ${key} должен быть непустой строкой`)
  }
  if (!COST_TIERS.includes(entry.cost_tier)) throw taggedError(1, `${name}: cost_tier должен быть одним из ${COST_TIERS.join('|')}`)
  if (typeof entry.local !== 'boolean') throw taggedError(1, `${name}: local должен быть булевым`)
  return entry
}

function taggedError(exit, message) {
  const err = new Error(message)
  err.exit = exit
  return err
}

// Overlay narrows, never widens (rule 5). It may add a NEW CLI and tweak
// model/effort/cost_tier of an existing one. It may NOT: grant `pd` (cut by
// force; if the cut empties the class list the load is REFUSED, exit 1 — not a
// silent drop), repin a base CLI's invoke/probe/data_classes/capabilities/local,
// or introduce a name outside ^[a-z0-9._-]+$ or a look-alike of a base name.
export function mergeRegistry(base, overlay) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw taggedError(2, 'реестр не прочитан: не объект')
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw taggedError(1, 'оверлей не прочитан: не объект')
  const baseNames = Object.keys(base)
  const merged = {}
  for (const [name, entry] of Object.entries(base)) merged[name] = { ...entry }
  for (const [name, entry] of Object.entries(overlay)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw taggedError(1, `${name}: оверлей должен быть объектом`)
    if (baseNames.includes(name)) {
      // Existing CLI: only model/effort/cost_tier move; harness stays locked.
      for (const key of OVERLAY_TWEAKABLE) if (key in entry) merged[name][key] = entry[key]
      continue
    }
    // New CLI: force-cut pd, then structural gates.
    const next = { ...entry }
    if (Array.isArray(next.data_classes)) {
      next.data_classes = next.data_classes.filter(c => c !== 'pd')
      // pd cut; if nothing survives, REFUSE (§16.4) — a silent drop leaves the
      // router green on a CLI it never chained. Distinct from "неизвестный класс".
      if (!next.data_classes.length) throw taggedError(1, `${name}: запрещённый класс вырезан, запись пуста`)
    }
    merged[name] = next
  }
  // Drop names outside the ASCII class and look-alikes of any base name — such a
  // name is indistinguishable from the real one in a log, so it never enters.
  for (const name of Object.keys(merged)) {
    if (baseNames.includes(name)) continue
    if (!ASCII_NAME_RE.test(name)) { delete merged[name]; continue }
    if (baseNames.some(b => isDoubleOf(name, b))) { delete merged[name]; continue }
  }
  for (const [name, entry] of Object.entries(merged)) validateEntry(name, entry)
  return merged
}

function readJsonFile(file, exitOnFail) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (e) { throw taggedError(exitOnFail, `реестр физически не прочитан (${path.basename(file)}): ${e.code || e.message}`) }
  try { return JSON.parse(raw) } catch (e) { throw taggedError(exitOnFail, `реестр не разобран (${path.basename(file)}): ${e.message}`) }
}

// Single truth for the class list (П24): the router's admission classes must be
// exactly the taxonomy's classes in config/data-classes.json, or the two borders
// drift within a month. A data_classes value absent there drops the load (exit 1).
function loadTaxonomyClassSet(file = DEFAULT_TAXONOMY) {
  try { return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).classes)) }
  catch { return null } // taxonomy absent (pre-П24) → skip; router's own axis stays fail-closed
}
function validateTaxonomy(registry, classSet) {
  if (!classSet) return registry
  for (const [name, entry] of Object.entries(registry)) {
    for (const c of entry.data_classes) {
      if (!classSet.has(c)) throw taggedError(1, `${name}: неизвестный класс данных «${c}» (нет в config/data-classes.json)`)
    }
  }
  return registry
}

export function loadRegistry({ registryPath = DEFAULT_REGISTRY, overlayPath = process.env.MNEMAZINE_CLI_REGISTRY_LOCAL || DEFAULT_OVERLAY } = {}) {
  const base = readJsonFile(registryPath, 2) // base missing/garbage → exit 2
  const explicitOverlay = Boolean(process.env.MNEMAZINE_CLI_REGISTRY_LOCAL)
  const overlay = overlayPath && existsSync(overlayPath)
    ? readJsonFile(overlayPath, 1)
    : explicitOverlay
      ? readJsonFile(overlayPath, 1)
      : {}
  return validateTaxonomy(mergeRegistry(base, overlay), loadTaxonomyClassSet())
}

// Static ordering (no probe): class → capability → cost tier. Returns either a
// non-empty ordered candidate list or a NAMED reason for the empty selection.
export function orderCandidates(registry, { dataClass = 'text', capabilities = [], tier } = {}) {
  const names = Object.keys(registry)
  if (!names.length) return { candidates: [], reason: 'реестр пуст' }
  if (!DATA_CLASSES.includes(dataClass)) return { candidates: [], reason: `неизвестный класс данных: ${dataClass}` }

  let pool
  if (dataClass === 'pd') {
    pool = names.filter(n => registry[n].local === true && registry[n].data_classes.includes('pd'))
    if (!pool.length) return { candidates: [], reason: 'класс pd: нет локальной CLI в реестре (pd не покидает устройство)' }
  } else {
    pool = names.filter(n => registry[n].data_classes.includes(dataClass))
    if (!pool.length) return { candidates: [], reason: `класс ${dataClass}: нет CLI в реестре` }
  }

  if (capabilities.length) {
    for (const cap of capabilities) {
      if (!pool.some(n => registry[n].capabilities.includes(cap))) {
        return { candidates: [], reason: `нет носителя возможности ${cap}` }
      }
    }
    const withAll = pool.filter(n => capabilities.every(cap => registry[n].capabilities.includes(cap)))
    if (!withAll.length) return { candidates: [], reason: `нет CLI со всеми возможностями: ${capabilities.join(',')}` }
    pool = withAll
  }

  if (tier) {
    if (!COST_TIERS.includes(tier)) return { candidates: [], reason: `неизвестный тир: ${tier}` }
    const capped = pool.filter(n => COST_RANK[registry[n].cost_tier] <= COST_RANK[tier])
    if (!capped.length) return { candidates: [], reason: `нет CLI тира <= ${tier}` }
    pool = capped
  }

  // Ascending cost: cheap first, chain ends at the most expensive available CLI
  // of the class. On --tier the cheap one already leads. Stable by name.
  const ordered = pool
    .sort((a, b) => COST_RANK[registry[a].cost_tier] - COST_RANK[registry[b].cost_tier] || a.localeCompare(b))
    .map(n => ({ name: n, ...registry[n] }))
  return { candidates: ordered, reason: null }
}

// Which schema adapter an entry uses — first declared mechanism wins.
export function pickSchemaAdapter(entry) {
  return SCHEMA_ADAPTERS.find(cap => (entry.capabilities || []).includes(cap)) || null
}

// Full decision with availability probing. `probeFn(name, entry) => boolean`.
export function decide(registry, opts = {}, probeFn) {
  const { candidates, reason } = orderCandidates(registry, opts)
  if (reason) return { executor: null, chain: [], skipped: [], reason }
  const available = []
  const skipped = []
  for (const cand of candidates) {
    const ok = probeFn ? probeFn(cand.name, cand) : true
    if (ok === true) available.push(cand)
    else skipped.push({ name: cand.name, reason: typeof ok === 'string' ? ok : 'недоступна' })
  }
  if (!available.length) {
    const detail = skipped.map(s => `${s.name}:${s.reason}`).join(', ')
    return { executor: null, chain: [], skipped, reason: `ни одна CLI класса ${opts.dataClass || 'text'} не доступна (${detail})` }
  }
  return { executor: available[0], chain: available.map(c => c.name), skipped, reason: null }
}

function realProbe(cachePath) {
  return (name, entry) => probeCli({ cli: name, probeCmd: entry.probe, cachePath }).outcome === 'ok'
}

// --- selftest (pure: no disk, no network) ------------------------------------
function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`selftest: ${msg}`) }
  const okProbe = () => true
  const entry = (over = {}) => ({
    probe: ['true'], invoke: ['true'], model: 'm', effort: 'max',
    data_classes: ['text', 'public', 'infra'], capabilities: ['json_in_prompt'],
    cost_tier: 'standard', local: false, ...over
  })
  const BASE = {
    claude: entry({ data_classes: ['personal', 'text', 'public', 'infra'], capabilities: ['json_schema_inline', 'json_in_prompt', 'web_search', 'stdin_prompt', 'long_context'], cost_tier: 'premium' }),
    codex: entry({ capabilities: ['json_schema_file', 'json_in_prompt', 'web_search', 'stdin_prompt'], cost_tier: 'standard' }),
    kimi: entry({ capabilities: ['json_in_prompt', 'long_context'], cost_tier: 'cheap' })
  }

  // merge + validation
  let reg = mergeRegistry(BASE, {})
  assert(Object.keys(reg).sort().join(',') === 'claude,codex,kimi', 'three base entries')
  assert(pickSchemaAdapter(reg.claude) === 'json_schema_inline', 'claude → inline')
  assert(pickSchemaAdapter(reg.codex) === 'json_schema_file', 'codex → file')
  assert(pickSchemaAdapter(reg.kimi) === 'json_in_prompt', 'kimi → in_prompt')

  // broken entry names itself
  try { mergeRegistry({ bad: entry({ invoke: [] }) }, {}); assert(false, 'no invoke must throw') }
  catch (e) { assert(/bad/.test(e.message) && e.exit === 1, 'broken entry names bad, exit 1') }
  try { mergeRegistry({ x: entry({ data_classes: [] }) }, {}); assert(false, 'empty classes must throw') }
  catch (e) { assert(/x/.test(e.message) && e.exit === 1, 'empty data_classes exit 1') }

  // empty registry → named reason, never "выбрано 0"
  assert(orderCandidates({}, { dataClass: 'text' }).reason === 'реестр пуст', 'empty → реестр пуст')

  // overlay grants pd-only → cut empties list → REFUSED, not a silent drop (§16.4)
  try { mergeRegistry(BASE, { zloy: entry({ data_classes: ['pd'] }) }); assert(false, 'pd-only overlay must throw') }
  catch (e) { assert(/zloy/.test(e.message) && e.exit === 1 && /запись пуста/.test(e.message), 'pd-only overlay refused exit 1') }
  // overlay hijacks base invoke → refused (base invoke preserved)
  reg = mergeRegistry(BASE, { claude: { invoke: ['/tmp/evil'], effort: 'low' } })
  assert(JSON.stringify(reg.claude.invoke) === JSON.stringify(BASE.claude.invoke), 'base invoke locked')
  assert(reg.claude.effort === 'low', 'overlay may tweak effort')
  // look-alikes and non-ASCII dropped, real harness kept
  reg = mergeRegistry(BASE, {
    Claude: entry({ capabilities: ['json_in_prompt'] }),
    'clаude': entry({ capabilities: ['json_in_prompt'] }),
    'claude ': entry({ capabilities: ['json_in_prompt'] }),
    'clαude': entry({ capabilities: ['json_in_prompt'] })
  })
  assert(!('Claude' in reg) && !('clаude' in reg) && !('claude ' in reg) && !('clαude' in reg), 'doubles dropped')
  assert('claude' in reg, 'real harness kept')
  assert(!isDoubleOf('claude-fast', 'claude') && !isDoubleOf('claude-code', 'claude'), 'legit suffixes not doubles')

  // capability with no carrier → named refusal (replaces the old per-provider literal)
  const kimiOnly = { kimi: BASE.kimi }
  assert(orderCandidates(kimiOnly, { dataClass: 'text', capabilities: ['web_search'] }).reason === 'нет носителя возможности web_search', 'web_search no carrier')
  // pd on base registry → no local carrier
  assert(/pd/.test(orderCandidates(BASE, { dataClass: 'pd' }).reason), 'pd fail-closed named')

  // cost ordering: cheap first
  const order = orderCandidates(mergeRegistry(BASE, {}), { dataClass: 'text' }).candidates.map(c => c.name)
  assert(order.join(',') === 'kimi,codex,claude', `cheap-first order, got ${order}`)

  // decide skips an unavailable CLI, chain not empty, reason named on total miss
  const chainReg = {
    fake: entry({ cost_tier: 'cheap' }),
    good: entry({ cost_tier: 'standard' })
  }
  const decision = decide(mergeRegistry(chainReg, {}), { dataClass: 'text' }, name => name !== 'fake')
  assert(decision.executor?.name === 'good', 'fake skipped, good chosen')
  const dead = decide(mergeRegistry(chainReg, {}), { dataClass: 'text' }, () => false)
  assert(dead.executor === null && /не доступна/.test(dead.reason), 'all dead → named refusal')

  // П24: if an overlay is provided via env, additionally validate the LIVE
  // registry+overlay against the taxonomy on disk. A poisoned class (e.g. an
  // overlay declaring data_classes:["secret"]) drops the load with exit 1 —
  // this is where the two borders are welded shut.
  if (process.env.MNEMAZINE_CLI_REGISTRY_LOCAL) {
    loadRegistry({ overlayPath: process.env.MNEMAZINE_CLI_REGISTRY_LOCAL })
  }

  console.log(JSON.stringify({ ok: true, selftest: 'cli-router' }))
  return 0
}

function main() {
  const { values } = parseArgs({
    options: {
      class: { type: 'string' },
      capability: { type: 'string' },
      tier: { type: 'string' },
      registry: { type: 'string' },
      overlay: { type: 'string' },
      cache: { type: 'string' },
      json: { type: 'boolean', default: false },
      selftest: { type: 'boolean', default: false }
    },
    allowPositionals: false
  })
  if (values.selftest) {
    try { return selftest() }
    catch (e) { console.error(`ОТКАЗ: ${e.message}`); return e.exit || 1 }
  }

  let registry
  try {
    registry = loadRegistry({
      registryPath: values.registry || DEFAULT_REGISTRY,
      overlayPath: values.overlay || DEFAULT_OVERLAY
    })
  } catch (e) {
    console.error(`ОТКАЗ: ${e.message}`)
    return e.exit || 1
  }

  const opts = {
    dataClass: values.class || 'text',
    capabilities: values.capability ? values.capability.split(',').map(s => s.trim()).filter(Boolean) : [],
    tier: values.tier
  }
  const decision = decide(registry, opts, realProbe(values.cache))
  if (values.json) console.log(JSON.stringify(decision))
  else if (decision.executor) console.log(`${opts.dataClass} → ${decision.executor.name} [chain: ${decision.chain.join(' → ')}]`)
  else console.error(`ОТКАЗ: ${decision.reason}`)
  return decision.executor ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
