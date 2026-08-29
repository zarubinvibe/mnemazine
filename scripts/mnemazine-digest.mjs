#!/usr/bin/env node
// Phase D — Russian human-readable digest, written AFTER Graphify.
// For each note: a humanizer-style Russian "Справка" section (Что это / О чем /
// Почему важно мне / Связи), with real connections pulled from the Graphify
// graph. Plus one session summary note mapping all processed atoms — so the
// knowledge is trivially reusable later.
//   node scripts/mnemazine-digest.mjs --vault <path> [--provider claude|codex] [--force]
// Needs an LLM (Codex default). No-op for notes already carrying a Справка
// unless --force. Default pipeline never calls this — it is a deep/opt-in stage.
import { promises as fs, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { activeProvider, llmAvailable, llmJson, fenceUntrusted } from './mnemazine-llm.mjs'
import { resolveVault } from './mnemazine-paths.mjs'
import { preservationCheck } from './mnemazine-humanize-gate.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)
function arg(name, fb = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fb
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fb
}

const VAULT = resolveVault({ cli: arg('vault') })
const SESSION = arg('session', new Date().toISOString().slice(0, 10))
const PROVIDER = arg('provider', process.env.MNEMAZINE_LLM || activeProvider())
const FORCE = argv.includes('--force')
const DETERMINISTIC = argv.includes('--deterministic') || process.env.MNEMAZINE_DIGEST_DETERMINISTIC === '1'
const LIMIT = Number(arg('limit', '0')) // 0 = no cap
const CHANGED_SINCE = arg('changed-since', '')
const SPRAVKA = '## Справка'

function sinceMs(value) {
  if (!value) return 0
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const CHANGED_SINCE_MS = sinceMs(CHANGED_SINCE)
// Personal project context stays out of the public repo. Set it once locally:
// env MNEMAZINE_OWNER_CONTEXT, or a gitignored file .mnemazine/owner-context.txt.
function ownerContext() {
  if (process.env.MNEMAZINE_OWNER_CONTEXT) return process.env.MNEMAZINE_OWNER_CONTEXT.trim()
  const f = path.join(ROOT, '.mnemazine/owner-context.txt')
  if (existsSync(f)) { try { return readFileSync(f, 'utf8').trim() } catch {} }
  return 'ваших проектов и работы'
}
const OWNER_CONTEXT = ownerContext()

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['zagolovok', 'chto_eto', 'o_chyom', 'pochemu_vazhno'],
  properties: {
    zagolovok: { type: 'string' },
    chto_eto: { type: 'string' },
    o_chyom: { type: 'string' },
    pochemu_vazhno: { type: 'string' }
  }
}

function digestPrompt(noteText, connections) {
  const conns = connections.length ? connections.map(c => `- ${c}`).join('\n') : '- (связей в графе пока нет)'
  return `Ты пишешь короткую человеческую справку по заметке знаний на РУССКОМ языке. Стиль humanizer: живо, ясно, по делу, без канцелярита и воды. Не выдумывай фактов сверх заметки.

Дай четыре поля:
- "zagolovok": точный человеческий заголовок (что это за знание).
- "chto_eto": 1-2 предложения — что это такое.
- "o_chyom": 1-2 предложения — о чем это, суть.
- "pochemu_vazhno": 1-2 предложения — почему это полезно в контексте ${OWNER_CONTEXT}.

Связанные знания из графа (для контекста, не пересказывай их):
${conns}

${fenceUntrusted('ЗАМЕТКА', noteText.slice(0, 12000))}`
}

// Map each note (vault-relative path) to related notes (also vault-relative paths).
// ponytail: derive note↔note links from note metadata, not the Graphify code-graph —
// `graphify update` emits only intra-note structural edges (contains), never
// note-to-note semantic links (those need the separate `graphify --update` pass with a
// model key). Same cluster_id = sibling atoms from one source; shared source-URL host =
// topically related. Cheap, deterministic, no extra deps. Cap at 6, siblings first.
const MAX_CONNECTIONS = 6
async function loadConnections() {
  const byNote = new Map()
  const titleByNote = new Map()
  const notes = [] // { rel, title, cluster, hosts:Set }
  for (const file of await walk(VAULT)) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (!text) continue
    const title = titleOf(text, file)
    const cluster = text.match(/^cluster_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || null
    const hosts = new Set()
    for (const m of text.matchAll(/https?:\/\/([^/\s)]+)/g)) hosts.add(m[1].replace(/^www\./, ''))
    const rel = path.relative(VAULT, file)
    titleByNote.set(rel, title)
    notes.push({ rel, title, cluster, hosts })
  }
  for (const a of notes) {
    const siblings = [], related = []
    for (const b of notes) {
      if (b.rel === a.rel) continue
      if (a.cluster && b.cluster === a.cluster) siblings.push(b.rel)
      else if ([...a.hosts].some(h => b.hosts.has(h))) related.push(b.rel)
    }
    const list = [...siblings, ...related].slice(0, MAX_CONNECTIONS)
    if (list.length) byNote.set(a.rel, list)
  }
  return { byNote, titleByNote }
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (/graphify-out|\.git|_digest/.test(item.name)) continue
      out.push(...await walk(p))
    } else if (item.isFile() && p.endsWith('.md')) out.push(p)
  }
  return out
}

function titleOf(text, file) {
  return text.match(/^title:\s*"([^"]+)"/m)?.[1] || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, '.md')
}

function linkAlias(rel, title) {
  const raw = title || path.basename(rel, '.md')
  const cleaned = String(raw).replace(/[\]\|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
  return /[А-Яа-яЁё]/.test(cleaned) ? cleaned : `Заметка: ${cleaned}`
}

function wikiLink(rel, title) {
  return `[[${rel.replace(/\.md$/, '')}|${linkAlias(rel, title)}]]`
}

function clean(text, max = 420) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function extractSection(text, names) {
  for (const name of names) {
    const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi')
    const hit = text.match(re)
    if (hit) return clean(hit[1])
  }
  return ''
}

function deterministicDigest(noteText, file) {
  const title = titleOf(noteText, file)
  const what = extractSection(noteText, ['Что это', 'Суть', 'What This Is'])
  const why = extractSection(noteText, ['Зачем это нужно', 'Почему важно', 'Why It Matters'])
  const how = extractSection(noteText, ['Как использовать', 'Что добавила Mnemazine', 'Reuse', 'How To Use It'])
  return {
    zagolovok: title,
    chto_eto: what || `Проверенная заметка по теме "${title}".`,
    o_chyom: how || what || 'Суть взята из финальной atom note и привязана к источникам.',
    pochemu_vazhno: why || `Полезно для ${OWNER_CONTEXT}: можно быстро понять, стоит ли применять это знание.`
  }
}

function spravkaBlock(d, connections, titleByNote) {
  const conns = connections.length ? connections.map(c => `- ${wikiLink(c, titleByNote.get(c))}`).join('\n') : '- (отдельных связей не найдено)'
  return `${SPRAVKA}

**${d.zagolovok}**

- **Что это:** ${d.chto_eto}
- **О чем:** ${d.o_chyom}
- **Почему важно мне:** ${d.pochemu_vazhno}

**Связи:**
${conns}
`
}

async function main() {
  const modelAvailable = !DETERMINISTIC && llmAvailable(PROVIDER)
  const { byNote: connByNote, titleByNote } = await loadConnections()
  const files = await walk(VAULT)
  const summary = []
  const lostNotes = []
  let written = 0
  for (const file of files) {
    if (LIMIT && written >= LIMIT) break
    if (CHANGED_SINCE_MS && (await fs.stat(file)).mtimeMs < CHANGED_SINCE_MS) continue
    const text = await fs.readFile(file, 'utf8')
    if (text.includes(SPRAVKA) && !FORCE) continue
    const rel = path.relative(VAULT, file)
    const connections = connByNote.get(rel) || []
    let d
    try {
      d = modelAvailable
        ? await llmJson(digestPrompt(text, connections), DIGEST_SCHEMA, { provider: PROVIDER })
        : deterministicDigest(text, file)
    } catch (err) {
      console.error(`[digest] failed for ${rel}: ${err.message}`)
      d = deterministicDigest(text, file)
    }
    if (!d?.zagolovok) continue
    // Справка is always appended last, so strip from its first occurrence to EOF.
    // (No `m` flag: a per-line `$` would stop at the first newline and leave the old
    // Справка in place, duplicating it on every --force run.)
    const stripped = FORCE ? text.replace(new RegExp(`\\n*${SPRAVKA}[\\s\\S]*$`), '\n') : text
    const block = spravkaBlock(d, connections, titleByNote)
    const newText = `${stripped.trimEnd()}\n\n${block}`
    // План П13 шаг 5: --force вырезает все от первого ## Справка до EOF — готовый путь
    // потери фактов. Перед записью гейт сохранности сверяет инварианты (числа/ссылки/
    // пути/код/frontmatter/заголовки; clean:false — читаемость не при чем, дайджест лишь
    // дописывает Справку). Потеря → файл не переписывается, расхождение в отчет, прогон
    // падает через run.mjs (digest.status !== 0).
    let guard
    try { guard = preservationCheck(text, newText, { clean: false }) }
    catch (err) { guard = { code: 2, lost: [{ kind: 'input', sample: String(err.message).slice(0, 120) }] } }
    if (guard.code !== 0) {
      lostNotes.push({ rel, code: guard.code, lost: guard.lost.slice(0, 8) })
      console.error(JSON.stringify({ digest_preservation_fail: rel, code: guard.code, lost: guard.lost.slice(0, 8) }))
      continue
    }
    await fs.writeFile(file, newText, 'utf8')
    summary.push({ rel, title: titleOf(text, file), zagolovok: d.zagolovok, connections })
    written += 1
  }

  // Session summary note — the reuse surface: what was learned + connection map.
  if (summary.length) {
    const dir = path.join(VAULT, '_digest')
    await fs.mkdir(dir, { recursive: true })
    const body = [
      `---\ntitle: "Сводка знаний — ${SESSION}"\ntype: "knowledge-digest"\nsource_ref: "digest:${SESSION}"\n---`,
      `\n# Сводка знаний — ${SESSION}\n`,
      `## Что это\n\nСводка связывает новые knowledge-note после digest-прогона и показывает, какие заметки теперь имеют человеческую справку.\n`,
      `## Зачем это нужно\n\nЭто финальный reuse-слой: после intake знание видно не только как отдельные файлы, но и как карта применимых связей.\n`,
      `## Как использовать\n\n- Открыть связанные заметки из списка ниже.\n- Взять сильные next actions в работу.\n- Проверить слабые или неподтвержденные связи перед публикацией.\n`,
      `## Источник\n\n- source_ref: digest:${SESSION}\n- processed_notes: ${summary.length}\n`,
      `## Проверка\n\nСводка построена локально из заметок vault и связей digest-этапа. Не является внешней факт-проверкой.\n`,
      `## Связанные заметки\n\n- [[Mnemazine Protocol|Протокол Mnemazine]]\n`,
      `## Повторное использование\n\nОбработано заметок: ${summary.length}. Ниже — что узнано и как связано.\n`,
      ...summary.map(s => `## ${s.zagolovok}\n\n- Заметка: ${wikiLink(s.rel, s.zagolovok || s.title)}\n- Связи: ${s.connections.length ? s.connections.map(c => wikiLink(c, titleByNote.get(c))).join(', ') : '—'}\n`)
    ].join('\n')
    await fs.writeFile(path.join(dir, `Сводка-${SESSION}.md`), body, 'utf8')
  }

  const ok = lostNotes.length === 0
  console.log(JSON.stringify({ ok, provider: PROVIDER, model_available: modelAvailable, written, summary: summary.length, linked: connByNote.size, preservation_failures: lostNotes.length, lost: lostNotes }, null, 2))
  // Ненулевой код роняет прогон (run.mjs: digest.status !== 0 → failRunState).
  if (!ok) process.exitCode = 1
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
