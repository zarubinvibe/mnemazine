#!/usr/bin/env node
// KB topic search — an orchestrator-led agent swarm over the live vault.
// Pipeline (mirrors the swarm playbook: recon -> fan-out -> fan-in):
//   1. RECON   (0 tokens): keyword-score every note, keep the top candidates.
//              --deep also asks the orchestrator to widen the query first.
//   2. FAN-OUT (swarm): shard candidates; a bounded pool of agents reads each
//              shard and returns findings (note / source / insight / relevance).
//              Workers write to a shared store (the result), never chat. One
//              failing worker never blocks the swarm (inner+outer try/catch).
//   3. FAN-IN  (synthesis): the orchestrator dedups + synthesizes findings into
//              a Russian "Справка" report. Generator != evaluator — workers
//              extract, the orchestrator judges and writes.
//   node scripts/mnemazine-kb-search.mjs --topic "..." [--vault <p>] [--deep]
// Default is conservative (0 tokens, local extract). --deep / MNEMAZINE_DEEP=1
// engages the LLM swarm. Report written to reports/ as Markdown; path printed.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'
import { activeProvider, llmAvailable, llmJson, fenceUntrusted } from './mnemazine-llm.mjs'

const argv = process.argv.slice(2)
const SELFTEST = argv.includes('--selftest')
function arg(name, fb = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fb
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fb
}

const DEEP = argv.includes('--deep') || process.env.MNEMAZINE_DEEP === '1'
const STDOUT = argv.includes('--stdout')
const JSON_OUT = argv.includes('--json')

if (argv.includes('--help')) {
  console.log(`mnemazine-kb-search.mjs — тематический поиск по корпусу знаний.
Локальный режим — 0 токенов; --deep (или MNEMAZINE_DEEP=1) — рой агентов с синтезом.

Использование: node scripts/mnemazine-kb-search.mjs --topic "<тема>" [флаги]
  --topic "<тема>"   тема поиска (обязательна)
  --vault <путь>     корпус (иначе MNEMAZINE_VAULT или repo-local vault)
  --out <каталог>    каталог отчёта (иначе MNEMAZINE_REPORTS или ./reports);
                     каталог внутри корпуса — отказ с кодом 2
  --stdout           отчёт в stdout, файл не создаётся
  --json             машинная выдача в stdout: results[] с note/score/subject/snippets
  --deep             LLM-рой: планирование запроса, шард-агенты, синтез
  --verify           отбраковка необоснованных находок (только с --deep)
  --concurrency N    параллелизм роя (по умолчанию 4)
  --max-notes N      потолок кандидатов для роя (по умолчанию 60)
  --shard-size N     заметок на агента (по умолчанию 6)
  --max-shards N     жёсткий потолок агентов в deep (по умолчанию 12)
  --selftest         селф-тест во временном каталоге
  --help             эта справка

Коды возврата: 0 — отчёт готов; 1 — ошибка или нет темы; 2 — отказ: каталог отчёта внутри корпуса.`)
  process.exit(0)
}
const PROVIDER = arg('provider', process.env.MNEMAZINE_LLM || activeProvider())
const CONCURRENCY = Number(arg('concurrency', process.env.MNEMAZINE_CONCURRENCY || '4'))
const MAX_NOTES = Number(arg('max-notes', '60'))     // candidate cap fed to the swarm
const SHARD_SIZE = Number(arg('shard-size', '6'))    // notes per agent
const MAX_SHARDS = Number(arg('max-shards', process.env.MNEMAZINE_SEARCH_MAX_SHARDS || '12')) // deep cost cap: hard limit on agents spawned
const EXCERPT = 2500                                  // chars of each note shown to an agent
// 2B perspective-diverse verify: opt-in (extra K agents). Default OFF to keep
// the token budget tight — enable when groundedness matters. One call per
// top-K finding, judging 3 lenses at once (grounded/relevant/actionable).
const VERIFY = argv.includes('--verify') || process.env.MNEMAZINE_SEARCH_VERIFY === '1'
const MAX_VERIFY = Number(arg('max-verify', '5')) // top-K findings to verify

// --- helpers -----------------------------------------------------------------
function isServicePath(p) {
  const parts = p.split(path.sep)
  if (parts.some(seg => seg === 'graphify-out' || seg === 'graphify-out-snapshots' || seg.startsWith('graphify-out-backup-'))) return true
  return parts.some((seg, i) => seg === '99 Система' && parts[i + 1] === '_archive')
}

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (isServicePath(full)) continue
    if (e.isDirectory()) await walk(full, out)
    else if (e.name.endsWith('.md')) out.push(full)
  }
  return out
}

const STOP = new Set(['the', 'and', 'для', 'что', 'как', 'это', 'про', 'или', 'был', 'are', 'with', 'из', 'на', 'по', 'не', 'от'])
const tokens = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => !STOP.has(t))
const uniq = xs => [...new Set(xs.filter(Boolean))]

function scoreNote(text, rel, terms) {
  const q = uniq(terms)
  if (!q.length) return 0
  const hayTokens = tokens(`${rel}\n${text}`)
  const relTokens = new Set(tokens(rel))
  const counts = new Map()
  for (const t of hayTokens) counts.set(t, (counts.get(t) || 0) + 1)
  const allTerms = q.every(t => counts.has(t))
  const hasBigram = q.length > 1 && q.slice(0, -1).some((t, i) =>
    hayTokens.some((h, j) => h === t && hayTokens[j + 1] === q[i + 1]))
  if (!allTerms && !hasBigram) return 0
  let score = 0
  for (const t of q) {
    score += Math.min(counts.get(t) || 0, 8)
    if (relTokens.has(t)) score += 4   // title/path hit weighs more
  }
  return score
}

function tokenIndex(text, term) {
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
  const m = rx.exec(text)
  return m ? m.index : -1
}

// Pull a few keyword-centered snippets — the local (0-token) "finding".
function snippets(text, terms, max = 3) {
  const out = []
  for (const t of uniq(terms)) {
    const i = tokenIndex(text, t)
    if (i === -1) continue
    const s = Math.max(0, i - 120), e = Math.min(text.length, i + 200)
    const snip = text.slice(s, e).replace(/\s+/g, ' ').trim()
    if (snip && !out.includes(snip)) out.push(snip)
    if (out.length >= max) break
  }
  return out
}

function frontmatterSubject(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const m = text.slice(3, end).match(/^subject:\s*(.*)$/mi)
  if (!m) return null
  const raw = m[1].trim()
  if (!raw || raw === 'null' || raw === '~') return null
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const items = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    return items.length ? items : null
  }
  return raw.replace(/^['"]|['"]$/g, '') || null
}

async function logQuery(entry) {
  const file = path.resolve('.mnemazine', 'state', 'kb-search-log.jsonl')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

// Bounded-concurrency pool — the swarm. One failing task never blocks the rest.
async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['note', 'insight', 'relevance'],
        properties: {
          note: { type: 'string' },
          source: { type: 'string' },
          insight: { type: 'string' },
          relevance: { type: 'integer', minimum: 1, maximum: 5 }
        }
      }
    }
  }
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'themes', 'gaps'],
  properties: {
    summary: { type: 'string' },
    themes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'points'],
        properties: { title: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } }
      }
    },
    connections: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } }
  }
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['grounded', 'relevant', 'actionable'],
  properties: {
    grounded: { type: 'boolean' }, relevant: { type: 'boolean' },
    actionable: { type: 'boolean' }, reason: { type: 'string' }
  }
}

// --- orchestrator: plan the query (deep only) --------------------------------
// 2A: one call returns BOTH search terms AND 2-4 facets (the real axes of THIS
// query). Facets steer 0-token recon routing, shard-agent focus, and synthesis
// themes — perspective diversity for ~free (no extra agents). Local mode skips
// it and stays 0-token (facets:[]).
async function plan(topic) {
  if (!DEEP || !llmAvailable(PROVIDER)) return { terms: tokens(topic), facets: [] }
  try {
    const out = await llmJson(
      `Тема поиска по базе знаний: "${topic}".
1) terms: ключевые слова и синонимы (рус+англ) для полнотекстового поиска — плоский список.
2) facets: 2-4 РЕАЛЬНЫЕ оси/под-вопроса именно этой темы (не общие "плюсы/минусы"). Для каждой: label (короткое имя оси) и terms (свои ключевые слова оси).`,
      {
        type: 'object', additionalProperties: false, required: ['terms', 'facets'],
        properties: {
          terms: { type: 'array', items: { type: 'string' } },
          facets: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['label', 'terms'],
              properties: { label: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }
            }
          }
        }
      },
      { provider: PROVIDER }
    )
    const terms = new Set(tokens(topic))
    for (const t of out.terms || []) for (const w of tokens(t)) terms.add(w)
    const facets = (out.facets || []).slice(0, 4)
      .map(f => ({ label: String(f.label || '').trim(), terms: [...new Set((f.terms || []).flatMap(tokens))] }))
      .filter(f => f.label && f.terms.length)
    for (const f of facets) for (const w of f.terms) terms.add(w)
    return { terms: [...terms], facets }
  } catch (e) {
    console.error(`[kb-search] query planning failed: ${e.message}; using raw terms`)
    return { terms: tokens(topic), facets: [] }
  }
}

// Assign a candidate note to its best-matching facet (max facet-term hits).
// 0-token. Returns facet label or 'Общее' when no facet wins.
function assignFacet(note, facets) {
  if (!facets.length) return null
  const hay = (note.rel + '\n' + note.text).toLowerCase()
  let best = null, bestN = 0
  for (const f of facets) {
    let n = 0
    for (const t of f.terms) if (hay.includes(t)) n++
    if (n > bestN) { bestN = n; best = f.label }
  }
  return best || 'Общее'
}

// --- worker: extract findings from one shard ---------------------------------
async function extractShard(topic, shard, facet) {
  if (DEEP && llmAvailable(PROVIDER)) {
    const blob = shard.map(n =>
      fenceUntrusted('NOTE', `### ${n.rel}\n${n.text.slice(0, EXCERPT)}`)).join('\n\n')
    const focus = facet ? `\nФокус-ось этого шарда: «${facet}» — приоритет находкам по этой оси (но не пропускай иное важное по теме).` : ''
    const prompt = `Ты агент-исследователь. Тема: "${topic}".${focus}
Из заметок ниже выбери ТОЛЬКО релевантное теме. Для каждой находки: note (путь заметки), source (URL/ссылка из заметки, если есть), insight (1-2 предложения по-русски — что важного для темы), relevance (1-5). Ничего не выдумывай сверх заметок.

${blob}`
    try {
      const out = await llmJson(prompt, FINDINGS_SCHEMA, { provider: PROVIDER, tools: [] })
      return (out.findings || []).filter(f => f.insight && f.relevance >= 2)
    } catch (e) {
      console.error(`[kb-search] shard agent failed: ${e.message}; local fallback`)
    }
  }
  // Local (0-token) fallback: snippet extraction.
  const terms = tokens(topic)
  return shard.flatMap(n => {
    const snips = snippets(n.text, terms)
    return snips.length ? [{ note: n.rel, source: n.url || '', insight: snips.join(' … '), relevance: Math.min(5, 2 + Math.floor(n.score / 4)) }] : []
  })
}

// --- verify (2B): perspective-diverse check on the top-K findings ------------
// One agent per finding, judging 3 lenses at once (grounded/relevant/actionable)
// against the note's own text. Bounded (K calls). Drops ungrounded findings —
// the anti-hallucination gate (§6 claim->content). Opt-in via VERIFY.
async function verifyFindings(topic, findings, textByNote) {
  if (!VERIFY || !DEEP || !llmAvailable(PROVIDER) || !findings.length) return { kept: findings, dropped: 0 }
  const top = findings.slice(0, MAX_VERIFY)
  const rest = findings.slice(MAX_VERIFY)
  const verdicts = []
  await mapLimit(top, CONCURRENCY, async (f, idx) => {
    const note = textByNote.get(f.note) || ''
    const prompt = `Тема: "${topic}". Находка из заметки «${f.note}»:
"${f.insight}"
Оцени по 3 осям относительно текста заметки ниже: grounded (находка реально опирается на текст, не выдумана), relevant (по теме), actionable (полезна на практике). Верни булевы + reason.

${fenceUntrusted('NOTE', note.slice(0, EXCERPT))}`
    try { verdicts[idx] = await llmJson(prompt, VERDICT_SCHEMA, { provider: PROVIDER, tools: [] }) }
    catch (e) { console.error(`[kb-search] verify failed for ${f.note}: ${e.message}; keeping finding`); verdicts[idx] = { grounded: true, relevant: true, actionable: true } }
  })
  const kept = top.filter((_, i) => verdicts[i]?.grounded !== false).concat(rest)
  return { kept, dropped: top.length - (kept.length - rest.length) }
}

// --- orchestrator: synthesize findings into a report -------------------------
async function synthesize(topic, findings, facets = []) {
  if (DEEP && llmAvailable(PROVIDER) && findings.length) {
    const blob = findings.map(f => `- [${f.note}] (rel ${f.relevance}) ${f.insight}${f.source ? ` <${f.source}>` : ''}`).join('\n')
    const axes = facets.length ? `\nСгруппируй по этим осям темы (themes), в этом порядке: ${facets.map(f => f.label).join(', ')}. Добавь иную ось только если находки не лезут ни в одну.` : ''
    const prompt = `Ты оркестратор. Собери из находок агентов справку по теме "${topic}" на РУССКОМ, стиль humanizer — живо, ясно, по делу, без воды и канцелярита. Дедуплицируй, сгруппируй по под-темам (themes), отметь связи (connections), противоречия (contradictions), пробелы знаний (gaps) и следующие шаги (next). Не выдумывай сверх находок.${axes}

Находки:
${blob}`
    try { return await llmJson(prompt, SYNTH_SCHEMA, { provider: PROVIDER }) }
    catch (e) { console.error(`[kb-search] synthesis failed: ${e.message}; local assembly`) }
  }
  // Local assembly: group by note, no LLM.
  const byNote = new Map()
  for (const f of findings) {
    if (!byNote.has(f.note)) byNote.set(f.note, [])
    byNote.get(f.note).push(f.insight)
  }
  const themes = [...byNote.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12)
    .map(([note, points]) => ({ title: note, points: [...new Set(points)] }))
  return {
    summary: `Найдено ${findings.length} совпадений в ${byNote.size} заметках по теме «${topic}» (локальный поиск без LLM).`,
    themes, connections: [], contradictions: [], gaps: [], next: []
  }
}

// --- report rendering --------------------------------------------------------
function slugify(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic' }

function renderReport(topic, report, meta) {
  const L = []
  L.push(`# Справка: ${topic}`, '')
  L.push(`> Поиск по базе знаний · ${meta.stamp} · просмотрено ${meta.scanned} заметок, отобрано ${meta.candidates}, находок ${meta.findings} · режим: ${meta.deep ? 'рой агентов (deep)' : 'локальный'}`, '')
  if (meta.facets?.length) L.push(`> Оси разбора: ${meta.facets.join(' · ')}`, '')
  if (meta.droppedNotes) L.push(`> ⚠️ Лимит стоимости: ${meta.droppedNotes} заметок-кандидатов не разобраны (--max-shards). Подними лимит для полного охвата.`, '')
  if (meta.droppedByVerify) L.push(`> 🔎 Verify: ${meta.droppedByVerify} находок отброшено как необоснованные.`, '')
  L.push('## Главное', '', report.summary || '—', '')
  if (report.themes?.length) {
    L.push('## По под-темам', '')
    for (const t of report.themes) {
      L.push(`### ${t.title}`)
      for (const p of t.points || []) L.push(`- ${p}`)
      L.push('')
    }
  }
  const block = (title, arr) => { if (arr?.length) { L.push(`## ${title}`, ''); for (const x of arr) L.push(`- ${x}`); L.push('') } }
  block('Связи', report.connections)
  block('Противоречия', report.contradictions)
  block('Пробелы', report.gaps)
  block('Дальше', report.next)
  return L.join('\n')
}

// --- main --------------------------------------------------------------------
async function run(topic, vault, outDir, { stdout = false, json = false } = {}) {
  const stamp = new Date().toISOString()
  const { terms, facets } = await plan(topic)
  // RECON
  const files = await walk(vault)
  const scored = []
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8').catch(() => '')
    if (!text) continue
    const rel = path.relative(vault, f)
    const score = scoreNote(text, rel, terms)
    if (score > 0) scored.push({ rel, text, score, subject: frontmatterSubject(text), url: text.match(/https?:\/\/\S+/)?.[0] || '' })
  }
  scored.sort((a, b) => b.score - a.score)
  const candidates = scored.slice(0, MAX_NOTES)
  if (json) {
    const results = candidates.map(n => ({
      note: n.rel,
      score: n.score,
      subject: n.subject,
      snippets: snippets(n.text, terms)
    }))
    await logQuery({ ts: stamp, topic, mode: 'json', results: results.length })
    process.stdout.write(`${JSON.stringify({ topic, scanned: files.length, results }, null, 2)}\n`)
    return null
  }
  // FAN-OUT — shard within facet groups so each shard carries one focus axis
  // (2A). No facets (local / planning failed) → flat sharding as before.
  let shards = []  // each: { notes:[...], facet }
  if (facets.length) {
    const groups = new Map()
    for (const c of candidates) {
      const f = assignFacet(c, facets)
      if (!groups.has(f)) groups.set(f, [])
      groups.get(f).push(c)
    }
    for (const [facet, notes] of groups)
      for (let i = 0; i < notes.length; i += SHARD_SIZE) shards.push({ notes: notes.slice(i, i + SHARD_SIZE), facet })
  } else {
    for (let i = 0; i < candidates.length; i += SHARD_SIZE) shards.push({ notes: candidates.slice(i, i + SHARD_SIZE), facet: null })
  }
  // Cost cap (deep only): fail-closed on the number of agents spawned. Local
  // mode is 0-token, so it is uncapped. Dropped shards are logged, never silent.
  let droppedNotes = 0
  if (DEEP && llmAvailable(PROVIDER) && shards.length > MAX_SHARDS) {
    droppedNotes = shards.slice(MAX_SHARDS).reduce((n, s) => n + s.notes.length, 0)
    console.error(`[kb-search] cost cap: ${shards.length} shards > MNEMAZINE_SEARCH_MAX_SHARDS=${MAX_SHARDS}; dropping ${shards.length - MAX_SHARDS} shards (${droppedNotes} notes). Raise --max-shards to cover more.`)
    shards = shards.slice(0, MAX_SHARDS)
  }
  const findings = []
  await mapLimit(shards, DEEP ? CONCURRENCY : 1, async shard => {
    try { findings.push(...await extractShard(topic, shard.notes, shard.facet)) }
    catch (e) { console.error(`[kb-search] shard failed: ${e.message}`) }
  })
  findings.sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
  // VERIFY (2B, opt-in): drop ungrounded top findings before synthesis.
  const textByNote = new Map(candidates.map(c => [c.rel, c.text]))
  const { kept, dropped: droppedByVerify } = await verifyFindings(topic, findings, textByNote)
  // FAN-IN
  const report = await synthesize(topic, kept, facets)
  const md = renderReport(topic, report, { stamp, scanned: files.length, candidates: candidates.length, findings: kept.length, deep: DEEP && llmAvailable(PROVIDER), droppedNotes, droppedByVerify, facets: facets.map(f => f.label) })
  await logQuery({ ts: stamp, topic, mode: DEEP && llmAvailable(PROVIDER) ? 'deep' : 'local', results: kept.length })
  if (stdout) {
    process.stdout.write(md.endsWith('\n') ? md : `${md}\n`)
    return null
  }
  await fs.mkdir(outDir, { recursive: true })
  const out = path.join(outDir, `search-${slugify(topic)}-${stamp.slice(0, 10)}-${Date.now()}.md`)
  await fs.writeFile(out, md, 'utf8')
  return out
}

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`selftest: ${m}`) }
  const tmp = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'kbsearch-'))
  const vault = path.join(tmp, 'vault'); await fs.mkdir(vault, { recursive: true })
  await fs.writeFile(path.join(vault, 'harness.md'), '# Agent harness\nСреда важнее модели. Контекст это бюджет. https://example.com/x', 'utf8')
  await fs.writeFile(path.join(vault, 'coffee.md'), '# Кофе\nЭспрессо и молоко.', 'utf8')
  const out = await run('agent harness контекст', vault, path.join(tmp, 'reports'))
  const md = await fs.readFile(out, 'utf8')
  assert(md.includes('Справка:'), 'report has header')
  assert(md.includes('harness.md'), 'relevant note surfaced')
  assert(!md.includes('coffee.md'), 'irrelevant note excluded')
  assert(!md.includes('Лимит стоимости'), 'no cost-cap warning when nothing dropped')
  const capped = renderReport('x', { summary: 's', themes: [] }, { stamp: 'now', scanned: 1, candidates: 1, findings: 1, deep: true, droppedNotes: 18 })
  assert(capped.includes('Лимит стоимости') && capped.includes('18'), 'cost-cap warning surfaced when shards dropped')
  await fs.rm(tmp, { recursive: true, force: true })
  console.log('selftest ok')
}

if (SELFTEST) {
  selftest().catch(e => { console.error(e.message); process.exit(1) })
} else {
  const topic = arg('topic') || argv.find(a => !a.startsWith('--'))
  if (!topic) { console.error('Usage: mnemazine-kb-search.mjs --topic "<тема>" [--deep] [--vault <p>]'); process.exit(1) }
  const vault = resolveVault({ cli: arg('vault') })
  const outDir = path.resolve(arg('out', process.env.MNEMAZINE_REPORTS || path.join(process.cwd(), 'reports')))
  // fail-closed: каталог отчёта внутри корпуса превращает просмотр в правку
  // корпуса — отказ держит код, а не привычку (план П08). С --stdout файла нет.
  const relOut = path.relative(vault, outDir)
  if (!STDOUT && !JSON_OUT && (relOut === '' || (!relOut.startsWith('..') && !path.isAbsolute(relOut)))) {
    console.error(`[kb-search] отказ: каталог отчёта внутри корпуса (out=${outDir}, vault=${vault}). Укажи --out вне корпуса или --stdout.`)
    process.exit(2)
  }
  run(topic, vault, outDir, { stdout: STDOUT, json: JSON_OUT })
    .then(p => { if (p) console.log(p) })
    .catch(e => { console.error(`[kb-search] ${e.message}`); process.exit(1) })
}
