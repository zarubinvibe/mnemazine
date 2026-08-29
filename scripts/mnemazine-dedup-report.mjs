#!/usr/bin/env node
// Кампания по СУЩЕСТВУЮЩИМ дублям vault — режим только-отчет.
// Гонит kb-embed query (заголовок + первые строки ноты) против общего индекса,
// собирает кластеры зон merge/flag, пишет отчет в «99 Система/_lint/».
// НИЧЕГО не мержит: мерж-вердикт — суждение, его исполняет Кими-рой по отчету.
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const SECTIONS = arg('sections', '01,07,08').split(',').map(s => s.trim()).filter(Boolean)
const INDEX = arg('index', path.join(VAULT, '99 Система', '_embeddings.json'))
const OUT = arg('out', path.join(VAULT, '99 Система', '_lint', `dedup-report-${new Date().toISOString().slice(0, 10)}.md`))
const TOPK = Number(arg('topk', '8'))
const JOBS = Number(arg('jobs', '4'))
const LIMIT = Number(arg('limit', '0')) // 0 = все ноты; >0 — смоук-прогон
const PYTHON = arg('python', path.join(os.homedir(), '.venvs', 'kb-embed', 'bin', 'python'))
const KB_EMBED = arg('kb-embed', path.join(os.homedir(), '.claude', 'skills', 'mnemazina', 'kb-embed.py'))
const QUERY_BODY_CHARS = 1200 // «первые строки»: меньше — самосовпадение ноты падает ниже merge-зоны
// Взаимность: ребро идет в кластеризацию, только если оба конца входят в топ-M партнеров друг друга.
// Без этого flag-транзитивность через хабы-подборки сшила 603 из 917 нот раздела 08 в один кластер
// (замер 2026-07-25). M=4: Camofox ×4 в одном кластере, макс кластер 249; M=3 рвет Camofox на 3+1.
const MUTUAL_TOP = Number(arg('mutual-top', '4'))

const nfc = s => s.normalize('NFC')

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text.trim()
  const end = text.indexOf('\n---', 3)
  return end === -1 ? text.trim() : text.slice(end + 4).trim()
}

function noteTitle(p) {
  return path.basename(p, '.md').replace(/^\d{4}-\d{2}-\d{2}\s*[—–-]\s*/u, '')
}

async function sectionDirs() {
  const entries = await fs.readdir(VAULT, { withFileTypes: true })
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  const picked = new Set()
  for (const want of SECTIONS) {
    for (const dir of dirs) {
      const exact = nfc(dir) === nfc(want)
      const prefix = /^\d\d$/.test(want) && dir.startsWith(`${want} `)
      if (exact || prefix) picked.add(dir)
    }
  }
  if (!picked.size) throw new Error(`Ни один раздел не совпал с --sections "${SECTIONS.join(',')}" в ${VAULT}`)
  return [...picked].map(d => path.join(VAULT, d))
}

async function collectNotes(dirs) {
  const notes = []
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('_') || item.name.startsWith('.')) continue
      const file = path.join(folder, item.name)
      if (item.isDirectory()) await walk(file)
      else if (item.isFile() && item.name.endsWith('.md')) notes.push(file)
    }
  }
  for (const dir of dirs) await walk(dir)
  notes.sort()
  return LIMIT > 0 ? notes.slice(0, LIMIT) : notes
}

function runQuery(text) {
  return new Promise(resolve => {
    const child = spawn(PYTHON, [KB_EMBED, 'query', INDEX, text, String(TOPK)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += String(c) })
    child.stderr.on('data', c => { stderr += String(c) })
    child.on('close', code => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', error => resolve({ code: 1, stdout, stderr: error.message }))
  })
}

async function noteMeta(p) {
  const raw = await fs.readFile(p, 'utf8').catch(() => null)
  if (raw === null) return { exists: false, date: '', chars: 0, body: '' }
  const body = stripFrontmatter(raw)
  const date = (raw.match(/^updated:\s*(\S+)/m)?.[1]
    || raw.match(/^created:\s*(\S+)/m)?.[1]
    || path.basename(p).match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
    || new Date((await fs.stat(p)).mtimeMs).toISOString().slice(0, 10)).replace(/["']/g, '')
  return { exists: true, date, chars: body.length, body }
}

// union-find: кластер = связная компонента по ребрам merge/flag
const parent = new Map()
function find(x) {
  if (!parent.has(x)) parent.set(x, x)
  let r = x
  while (parent.get(r) !== r) r = parent.get(r)
  while (parent.get(x) !== x) { const n = parent.get(x); parent.set(x, r); x = n }
  return r
}
function union(a, b) { parent.set(find(a), find(b)) }

async function main() {
  if (!existsSync(INDEX)) throw new Error(`Индекс не найден: ${INDEX} — сначала kb-embed build`)
  if (!existsSync(KB_EMBED)) throw new Error(`kb-embed не найден: ${KB_EMBED}`)
  const dirs = await sectionDirs()
  const notes = await collectNotes(dirs)
  console.error(`Разделы: ${dirs.map(d => path.basename(d)).join(' · ')} — ${notes.length} нот, jobs=${JOBS}`)

  const edges = new Map() // "a\0b" (упорядоченно) → лучшее ребро пары
  const failures = []
  let done = 0
  let cursor = 0

  async function worker() {
    while (cursor < notes.length) {
      const note = notes[cursor++]
      const meta = await noteMeta(note)
      if (!meta.body) { done++; continue }
      const text = `${noteTitle(note)}\n${meta.body.slice(0, QUERY_BODY_CHARS)}`
      const res = await runQuery(text)
      done++
      if (done % 50 === 0) console.error(`  ...${done}/${notes.length}`)
      let parsed
      try { parsed = JSON.parse(res.stdout) } catch { parsed = null }
      if (res.code !== 0 || !parsed || parsed.error) {
        failures.push({ note, detail: parsed?.error || res.stderr.slice(0, 200) || `exit ${res.code}` })
        continue
      }
      for (const m of parsed.matches || []) {
        if (nfc(m.note) === nfc(note)) continue // самосовпадение — не дубль
        if (m.zone !== 'merge' && m.zone !== 'flag') continue
        // служебные плоскости (_archive и пр.) — страховка на случай индекса, собранного старым build
        if (m.note.split(path.sep).some(seg => seg.startsWith('_'))) continue
        const [a, b] = [note, m.note].sort()
        const key = `${a}\0${b}`
        const prev = edges.get(key)
        if (!prev || m.combined > prev.combined) edges.set(key, { a, b, ...m })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, JOBS) }, worker))

  if (failures.length) {
    console.error(`kb-embed query упал на ${failures.length} нотах, отчет не пишу (fail-closed):`)
    for (const f of failures.slice(0, 10)) console.error(`  ${f.note}: ${f.detail}`)
    process.exit(1)
  }

  // взаимный фильтр ребер → union-find → сборка кластеров
  const partners = new Map() // нота → ее ребра по убыванию combined
  for (const e of edges.values()) {
    for (const n of [e.a, e.b]) {
      if (!partners.has(n)) partners.set(n, [])
      partners.get(n).push(e)
    }
  }
  for (const list of partners.values()) list.sort((x, y) => y.combined - x.combined)
  const inTop = (n, e) => partners.get(n).slice(0, MUTUAL_TOP).includes(e)
  const kept = [...edges.values()].filter(e => inTop(e.a, e) && inTop(e.b, e))
  for (const e of kept) union(e.a, e.b)
  const byRoot = new Map()
  for (const e of kept) {
    const root = find(e.a)
    if (!byRoot.has(root)) byRoot.set(root, { members: new Set(), edges: [] })
    const c = byRoot.get(root)
    c.members.add(e.a); c.members.add(e.b); c.edges.push(e)
  }
  const clusters = []
  for (const c of byRoot.values()) {
    const members = []
    for (const p of c.members) {
      const meta = await noteMeta(p)
      const best = c.edges.filter(e => e.a === p || e.b === p)
        .reduce((x, e) => (!x || e.combined > x.combined ? e : x), null)
      members.push({ path: p, ...meta, best })
    }
    // канон: свежее побеждает, при равной дате — полнее (объем тела)
    members.sort((x, y) => y.date.localeCompare(x.date) || y.chars - x.chars)
    const zone = c.edges.some(e => e.zone === 'merge') ? 'merge' : 'flag'
    clusters.push({ zone, members, edges: c.edges })
  }
  clusters.sort((x, y) => (x.zone === y.zone ? y.members.length - x.members.length : x.zone === 'merge' ? -1 : 1))

  const today = new Date().toISOString().slice(0, 10)
  const mergeCount = clusters.filter(c => c.zone === 'merge').length
  const lines = [
    `# Dedup-отчет Мнемозины — ${today}`,
    '',
    'Режим только-отчет: ничего не слито. Мерж-вердикт — суждение, его исполняет Кими-рой по этому отчету.',
    '',
    `- Разделы: ${dirs.map(d => path.basename(d)).join(' · ')} — просканировано ${notes.length} нот`,
    `- Индекс: ${INDEX}`,
    `- Зоны (kb-embed): merge ≥ 0.90 · flag ≥ 0.72 по combined = cosine + 0.3×title_sim (title_sim ≥ 0.5)`,
    `- Кластеризация: только взаимные ребра (оба конца в топ-${MUTUAL_TOP} партнеров друг друга) — против сшивания через хабы-подборки`,
    `- Кластеров: ${clusters.length} (merge: ${mergeCount}, flag: ${clusters.length - mergeCount})`,
    '',
  ]
  clusters.forEach((c, i) => {
    lines.push(`## Кластер ${i + 1} — ${c.zone} (${c.members.length} нот)`)
    const canon = c.members[0]
    lines.push(`Кандидат-канон: **${path.relative(VAULT, canon.path)}** (${canon.date}, ${canon.chars} симв — свежее/полнее остальных)`)
    lines.push('')
    lines.push('| нота | зона | combined | cosine | title_sim | дата | симв |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const m of c.members) {
      const rel = path.relative(VAULT, m.path) + (m.exists ? '' : ' ⚠️ файла нет — индекс отстал')
      lines.push(`| ${rel} | ${m.best.zone} | ${m.best.combined} | ${m.best.score} | ${m.best.title_sim} | ${m.date || '?'} | ${m.chars} |`)
    }
    lines.push('')
  })
  if (!clusters.length) lines.push('Дублей в зонах merge/flag не найдено.')

  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, lines.join('\n') + '\n', 'utf8')
  console.log(JSON.stringify({ report: OUT, scanned: notes.length, clusters: clusters.length, merge: mergeCount, flag: clusters.length - mergeCount }))
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
