#!/usr/bin/env node
// План П13 — гейт сохранности очеловечивания. Держит два условия кодом:
//   читаемость (сканер humanizer-ru) и сохранность фактов (инварианты «до» ⊆ «после»).
//
// Режимы:
//   --before A --after B [--json] [--no-clean] [--porog N]  сверка одной пары
//   --selftest                                              фикстуры (красный кролик)
//   --baseline --vault V --out O --report R                 распределение чистоты по корпусу
//   --sweep --vault V --changed-since ISO [--porog N]        читаемость измененных нот (розетка run.mjs)
//
// Коды: 0 — все на месте; 1 — потерян инвариант / hard ban / грязь; 2 — ошибка входа
// (нет файла, битый frontmatter, сканер не запустился). scan.py при hard bans выходит с 1,
// но печатает валидный JSON — это НЕ ошибка входа, это грязный текст (наш код 1).
import { promises as fs, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SPEC_BODY_HEADINGS, SPEC_UNTOUCHABLE_HEADINGS } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCANNER = path.join(ROOT, 'skills/humanizer-ru/scripts/scan.py')
const CORPUS_SCANNER = path.join(ROOT, 'skills/humanizer-ru/scripts/scan_corpus.py')
const VENV_PY = path.join(ROOT, '.venv/bin/python')
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3'
// ponytail: порог — граница «рерайт» из scan.py:54 (<60 текст требует переписывания).
const POROG_DEFAULT = Number(process.env.MNEMAZINE_HUMANIZE_POROG || 60)
const EM_DASH_BAN = 'Длинное тире' // сквозной в корпусе (95% hard bans) — не слоп

class InputError extends Error {} // → exit 2

// ── сканер читаемости ────────────────────────────────────────────────────────
// Возвращает {score, band, hard_ban_count}. Отличает «сканер сломан» (InputError→2)
// от «текст грязный» (валидный JSON, hard_ban_count>0 → зовущий решает).
function runScanner(prose) {
  if (!existsSync(SCANNER)) throw new InputError(`сканер не найден: ${SCANNER}`)
  const r = spawnSync(PY, [SCANNER, '-', '--json'], { input: prose, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new InputError(`сканер не запустился: ${r.error.message}`)
  if (r.stderr && /Traceback|ModuleNotFoundError/.test(r.stderr)) {
    throw new InputError(`сканер упал: ${r.stderr.trim().split('\n').pop()}`)
  }
  let json
  try { json = JSON.parse(r.stdout) } catch {
    throw new InputError(`сканер вернул не-JSON на stdout (${(r.stdout || '').slice(0, 80)})`)
  }
  if (!json.score || typeof json.score.score !== 'number') throw new InputError('в выдаче сканера нет score')
  const hardBans = Array.isArray(json.hard_bans) ? json.hard_bans : []
  // Длинное тире сквозное в корпусе (даты/заголовки) — считаем отдельно от слопа.
  const slop = hardBans.filter(([name]) => name !== EM_DASH_BAN).reduce((s, [, n]) => s + (n | 0), 0)
  return { score: json.score.score, band: json.score.band, hard_ban_count: json.hard_ban_count | 0, hard_bans: hardBans, slop_ban_count: slop }
}

// ── неприкасаемые зоны (сверяются побайтово) ─────────────────────────────────
function frontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  if (!m) throw new InputError('битый frontmatter: нет закрывающего ---')
  return m[0]
}
function fences(text) { return text.match(/```[\s\S]*?```/g) || [] }
function stripFences(text) { return text.replace(/```[\s\S]*?```/g, ' ') }
function inlineCode(noFences) { return noFences.match(/`[^`\n]+`/g) || [] }

function sectionBlock(text, re) {
  const rx = new RegExp(re.source, 'm')
  const m = rx.exec(text)
  if (!m) return null
  const from = m.index
  const after = text.slice(from + m[0].length)
  const nx = after.search(/\n##\s+/)
  return nx === -1 ? text.slice(from) : text.slice(from, from + m[0].length + nx)
}
function untouchableSections(text) {
  return SPEC_UNTOUCHABLE_HEADINGS.map(h => sectionBlock(text, h.re)).filter(Boolean)
}
function lineBlocks(text, test) {
  const out = []; let cur = []
  for (const ln of text.split('\n')) {
    if (test(ln)) cur.push(ln)
    else { if (cur.length) out.push(cur.join('\n')); cur = [] }
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}
const numberTables = text => lineBlocks(text, ln => /^\s*\|/.test(ln)).filter(b => /\d/.test(b))
const quoteBlocks = text => lineBlocks(text, ln => /^\s*>/.test(ln))

// ── токен-инварианты ─────────────────────────────────────────────────────────
const RX = {
  url: /https?:\/\/[^\s)>\]"'`]+/g,
  wikilink: /\[\[[^\]]+\]\]/g,
  path: /(?:~|\.{0,2})\/[^\s`)>\]"']+|[\w.\-/]+\.(?:mjs|py|json|md|sh|ts|js|txt|yml|yaml)\b/g,
  number: /\d+(?:[.,]\d+)?/g,
  version: /\bv?\d+\.\d+(?:\.\d+)?\b/g,
  isoDate: /\b\d{4}-\d{2}-\d{2}\b/g,
  latin: /[A-Za-z][A-Za-z0-9_-]{2,}/g
}
const matchAll = (text, re) => text.match(re) || []
function countMap(list) { const m = new Map(); for (const v of list) m.set(v, (m.get(v) || 0) + 1); return m }

// множества-инварианты: byte-blocks (verbatim) + токены (мультимножество/множество) + заголовки.
function collectInvariants(before) {
  const fm = frontmatter(before)
  const nf = stripFences(before)
  const byteBlocks = [
    ...(fm ? [fm] : []),
    ...fences(before),
    ...inlineCode(nf),
    ...untouchableSections(before),
    ...numberTables(before),
    ...quoteBlocks(before)
  ]
  const headings = SPEC_BODY_HEADINGS.filter(h => new RegExp(h.re.source, 'm').test(before))
  return {
    byteBlocks,
    headings,
    tokens: {
      url: countMap(matchAll(before, RX.url)),
      wikilink: countMap(matchAll(before, RX.wikilink)),
      path: countMap(matchAll(before, RX.path)),
      number: countMap(matchAll(before, RX.number)),
      version: countMap(matchAll(before, RX.version)),
      isoDate: countMap(matchAll(before, RX.isoDate)),
      latin: new Set(matchAll(before, RX.latin))
    }
  }
}

// ── MQM (прием 40): вердикт не бинарный — какая рубрика провалилась ───────────
function mqm(lost, cleanliness) {
  const cat = k => lost.filter(l => l.kind === k)
  return {
    accuracy: cat('number').length + cat('url').length + cat('path').length + cat('wikilink').length +
      cat('version').length + cat('isoDate').length + cat('byte').length === 0,
    language: cleanliness ? cleanliness.hard_ban_count === 0 : null,
    style: cleanliness ? cleanliness.score >= POROG_DEFAULT : null,
    terminology: cat('latin').length + cat('heading').length === 0
  }
}

// ── ядро: сверка одной пары ───────────────────────────────────────────────────
// clean=false — только сохранность фактов (охрана дайджеста: он лишь дописывает Справку).
export function preservationCheck(before, after, { clean = true, porog = POROG_DEFAULT } = {}) {
  const inv = collectInvariants(before) // бросит InputError на битом frontmatter
  const lost = []

  for (const block of inv.byteBlocks) {
    if (!after.includes(block)) lost.push({ kind: 'byte', sample: block.slice(0, 60) })
  }
  for (const [kind, re] of [['url', RX.url], ['wikilink', RX.wikilink], ['path', RX.path], ['number', RX.number], ['version', RX.version], ['isoDate', RX.isoDate]]) {
    const afterCount = countMap(matchAll(after, re))
    for (const [val, n] of inv.tokens[kind]) {
      if ((afterCount.get(val) || 0) < n) lost.push({ kind, sample: val })
    }
  }
  const afterLatin = new Set(matchAll(after, RX.latin))
  for (const tok of inv.tokens.latin) if (!afterLatin.has(tok)) lost.push({ kind: 'latin', sample: tok })
  for (const h of inv.headings) {
    if (!new RegExp(h.re.source, 'm').test(after)) lost.push({ kind: 'heading', sample: h.title })
  }

  let cleanliness = null
  if (clean) {
    let prose = after
    const fm = frontmatter(after)
    if (fm) prose = prose.slice(fm.length)
    prose = stripFences(prose).replace(/`[^`\n]+`/g, ' ')
    for (const s of untouchableSections(after)) prose = prose.replace(s, ' ')
    cleanliness = runScanner(prose) // InputError → 2 у зовущего
  }

  const dirty = clean && cleanliness && (cleanliness.hard_ban_count > 0 || cleanliness.score < porog)
  const code = (lost.length || dirty) ? 1 : 0
  return { code, lost, cleanliness, dirty: !!dirty, mqm: mqm(lost, cleanliness) }
}

// ── режимы CLI ────────────────────────────────────────────────────────────────
function arg(name, fb = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fb
  const v = process.argv[i + 1]
  return (v && !v.startsWith('--')) ? v : fb
}
const has = name => process.argv.includes(`--${name}`)

async function readNote(file) {
  if (!existsSync(file)) throw new InputError(`нет файла: ${file}`)
  return fs.readFile(file, 'utf8')
}

async function runPair() {
  const beforeF = arg('before'), afterF = arg('after')
  if (!beforeF || !afterF) throw new InputError('нужны --before <файл> --after <файл>')
  const before = await readNote(beforeF)
  const after = await readNote(afterF)
  const porog = Number(arg('porog', String(POROG_DEFAULT)))
  const res = preservationCheck(before, after, { clean: !has('no-clean'), porog })
  if (has('json')) console.log(JSON.stringify({ before: beforeF, after: afterF, ...res }, null, 2))
  else {
    if (res.code === 0) console.log(`✓ сохранность цела${res.cleanliness ? `, чистота ${res.cleanliness.score}/100` : ''}`)
    else {
      if (res.lost.length) console.error(`✗ потеряно инвариантов: ${res.lost.length} → ${res.lost.slice(0, 8).map(l => `${l.kind}:${l.sample}`).join(' · ')}`)
      if (res.dirty) console.error(`✗ грязный текст: score ${res.cleanliness.score}/100, hard bans ${res.cleanliness.hard_ban_count}`)
    }
  }
  return res.code
}

const FIX = path.join(ROOT, 'tests/fixtures/humanize')
async function runSelftest() {
  // Красный кролик (прием 2): битая фикстура гоняется в каждом прогоне.
  // Зеленый кролик (broken вернул 0) = провал самого гейта.
  const cases = [
    { name: 'note-after-broken.md', expect: 1 },
    { name: 'note-after-ok.md', expect: 0 }
  ]
  const beforeF = path.join(FIX, 'note-before.md')
  if (!existsSync(beforeF)) { console.error(`нет фикстуры ${beforeF} (проба-украшение)`); return 1 }
  const before = await readNote(beforeF)
  let extracted = 0
  for (const c of cases) {
    const f = path.join(FIX, c.name)
    if (!existsSync(f)) { console.error(`нет фикстуры ${f}`); return 1 }
    extracted += 1
    const res = preservationCheck(before, await readNote(f), { clean: true }) // InputError (нет сканера) → 2
    if (res.code !== c.expect) {
      console.error(`✗ selftest: ${c.name} дал ${res.code}, ждали ${c.expect}` +
        (res.lost.length ? ` (потери: ${res.lost.map(l => l.kind).join(',')})` : '') +
        (res.dirty ? ` (грязь: ${res.cleanliness.score})` : ''))
      return 1
    }
    console.log(`✓ selftest: ${c.name} → ${res.code}`)
  }
  if (extracted === 0) { console.error('ноль извлеченных фикстур'); return 1 }
  console.log('✓ selftest: красный кролик красный, честный рерайт зеленый')

  // deslop: снимает названный слоп, держит факты, НЕ трогает то, что не умеет.
  // Красный кролик против регрессии кириллического `\b` (JS `\b` — ASCII-only).
  const fixable = 'Это является ключевым паттерном v2. Видно не только как файл, но и как карта.'
  const cleaned = deslop(fixable)
  if (runScanner(cleaned).slop_ban_count !== 0) { console.error(`✗ selftest deslop: слоп не снят: ${cleaned}`); return 1 }
  if (!cleaned.includes('v2')) { console.error('✗ selftest deslop: потерян факт-токен v2'); return 1 }
  const unfixable = 'Это комплексный подход к памяти.'
  if (runScanner(deslop(unfixable)).slop_ban_count === 0) { console.error('✗ selftest deslop: незнакомый бан молча снят (сторож ослеп)'); return 1 }
  console.log('✓ selftest: deslop снимает названный слоп и держит факты, незнакомый бан оставляет')
  return 0
}

function scanCorpus(vault) {
  if (!existsSync(CORPUS_SCANNER)) throw new InputError(`нет корпус-драйвера: ${CORPUS_SCANNER}`)
  const r = spawnSync(PY, [CORPUS_SCANNER, vault], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (r.error) throw new InputError(`корпус-сканер не запустился: ${r.error.message}`)
  if (r.status === 2) throw new InputError(`корпус-сканер: ${(r.stderr || '').trim()}`)
  if (r.stderr && /Traceback|ModuleNotFoundError/.test(r.stderr)) throw new InputError(`корпус-сканер упал: ${r.stderr.trim().split('\n').pop()}`)
  const rows = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => typeof x.score === 'number')
  return rows
}
function pct(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length)); return sorted[i] }

async function runBaseline() {
  const vault = resolveVault({ cli: arg('vault') })
  const out = arg('out', '.mnemazine/state/humanize-baseline.json')
  const report = arg('report', '')
  const rows = scanCorpus(vault)
  if (rows.length < 1) throw new InputError('корпус пуст: 0 нот отсканировано')
  const scores = rows.map(r => r.score).sort((a, b) => a - b)
  const bands = {
    clean: rows.filter(r => r.score >= 85).length,       // ≥85 чисто
    spot: rows.filter(r => r.score >= 60 && r.score < 85).length, // 60-84 точечная правка
    rewrite: rows.filter(r => r.score < 60).length        // <60 рерайт
  }
  const worst = rows.slice().sort((a, b) => a.score - b.score).slice(0, 300)
    .map(r => ({ path: r.path, score: r.score, hard_ban_count: r.hard_ban_count }))
  const data = {
    generated_at: arg('now', ''), // штамп извне (Date.now() в скриптах воркфлоу запрещен; тут CLI — допустимо, но оставляем внешним)
    vault,
    notes_scanned: rows.length,
    median_score: pct(scores, 50),
    p10_score: pct(scores, 10),
    bands,
    hard_ban_notes: rows.filter(r => r.hard_ban_count > 0).length,
    // настоящий слоп (кроме сквозного «Длинное тире») — очередь кампании важнее полосы
    slop_ban_notes: rows.filter(r => (r.slop_ban_count | 0) > 0).length,
    worst
  }
  if (!data.generated_at) data.generated_at = new Date().toISOString()
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await fs.writeFile(out, JSON.stringify(data, null, 2), 'utf8')
  if (report) {
    const md = [
      `# Базовый замер читаемости корпуса — ${data.generated_at.slice(0, 10)}`,
      '',
      `Vault: \`${vault}\` · нот отсканировано: **${data.notes_scanned}** (вне graphify-каталогов).`,
      `Прибор: \`skills/humanizer-ru/scripts/scan.py\` (детерминированный сканер humanizer-ru, П12).`,
      '',
      '## Распределение по полосам чистоты (scan.py:54)',
      '',
      '| Полоса | Порог | Нот | Доля |',
      '|---|---|---|---|',
      `| чисто | ≥85 | ${bands.clean} | ${(bands.clean / rows.length * 100).toFixed(1)}% |`,
      `| точечная правка | 60–84 | ${bands.spot} | ${(bands.spot / rows.length * 100).toFixed(1)}% |`,
      `| рерайт | <60 | ${bands.rewrite} | ${(bands.rewrite / rows.length * 100).toFixed(1)}% |`,
      '',
      `Медиана: **${data.median_score}** · p10: **${data.p10_score}**.`,
      '',
      `Нот с hard bans: **${data.hard_ban_notes}** из ${rows.length} — но ${data.hard_ban_notes - data.slop_ban_notes} из них только за счет сквозного «Длинное тире» (даты и заголовки).`,
      `Нот с настоящим слопом (кроме em-dash): **${data.slop_ban_notes}** — вот реальная очередь на очеловечивание. Sweep конвейера краснит именно на слопе, не на em-dash.`,
      '',
      '## Первые 20 худших (очередь кампании П13)',
      '',
      '| score | нота |',
      '|---|---|',
      ...worst.slice(0, 20).map(w => `| ${w.score} | \`${path.basename(w.path)}\` |`),
      '',
      'Замер read-only: vault не изменялся. Кампания П13 берет `worst` из json как `--worst-first`.'
    ].join('\n')
    await fs.mkdir(path.dirname(path.resolve(report)), { recursive: true })
    await fs.writeFile(report, md + '\n', 'utf8')
  }
  console.log(JSON.stringify({ notes_scanned: data.notes_scanned, median: data.median_score, p10: data.p10_score, bands, hard_ban_notes: data.hard_ban_notes }, null, 2))
  return 0
}

function isServicePath(rel) {
  return rel.split(path.sep).some(s => s.startsWith('.') || s.startsWith('_')) || rel.includes('graphify-out')
}

// Проза, как ее видит sweep: без frontmatter, кода, инлайн-кода и неприкасаемых
// секций. Слоп меряем ровно на ней — там же, где sweep решает fatal (правило 8:
// одна правда об «где искать слоп» на обе розетки).
function proseForScan(text) {
  let prose = text
  const fm = frontmatter(text); if (fm) prose = prose.slice(fm.length)
  prose = stripFences(prose).replace(/`[^`\n]+`/g, ' ')
  for (const s of untouchableSections(text)) prose = prose.replace(s, ' ')
  return prose
}
function slopOf(text) { return runScanner(proseForScan(text)).slop_ban_count }

// Детерминированный перефраз hard-ban конструкций. Правит ТОЛЬКО filler-слова и
// копулу (фактов не несут) — числа/ссылки/пути/латиница/wikilinks не трогаются,
// потому инвариант «до» ⊆ «после» держится (сверяет preservationCheck у зовущего).
// Em-dash легален (sweep на него не фатален), потому «является» → « — ».
// ponytail: узкий набор — те hard bans, что снимаются без морфологии. Все прочее
// пас не чинит и честно роняет прогон (fail-closed). Апгрейд — LLM-эскалация на
// 2-й итерации (как в кампании), когда живой прогон покажет незакрытый хвост.
function matchCase(replacement, original) {
  return /^[А-ЯЁ]/.test(original) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement
}
// Кириллические границы слова: JS `\b` — ASCII-only и НИКОГДА не срабатывает вокруг
// кириллицы (в отличие от Unicode-`\b` в Python-сканере). Свои границы: «не буква».
// Зеркалят HARD_BANS сканера, чтобы deslop снимал ровно то, что метит sweep.
const NB = '(?<![А-Яа-яЁёA-Za-z])'
const NA = '(?![А-Яа-яЁёA-Za-z])'
const DAN = { 'данный': 'этот', 'данная': 'эта', 'данное': 'это', 'данного': 'этого', 'данной': 'этой', 'данном': 'этом', 'данную': 'эту' }
function deslop(text) {
  let t = text
  // Пустые вводные — снять целиком, остаток предложения остается фактом.
  t = t.replace(new RegExp(`${NB}стоит\\s+отметить,?\\s+что\\s+`, 'gi'), '')
  t = t.replace(new RegExp(`${NB}важно\\s+понимать,?\\s+что\\s+`, 'gi'), '')
  t = t.replace(new RegExp(`${NB}можно\\s+с\\s+уверенностью\\s+сказать,?\\s+что\\s+`, 'gi'), '')
  t = t.replace(new RegExp(`${NB}в\\s+современном\\s+мире,?\\s+`, 'gi'), '')
  t = t.replace(new RegExp(`${NB}(?:подводя\\s+итог|таким\\s+образом),?\\s+`, 'gi'), '')
  t = t.replace(new RegExp(`${NB}в\\s+связи\\s+с\\s+этим${NA}`, 'gi'), 'поэтому')
  // «Не только X, но и Y» → «и X, и Y».
  t = t.replace(new RegExp(`${NB}не\\s+только${NA}`, 'gi'), 'и').replace(new RegExp(`${NB}но\\s+и${NA}`, 'gi'), 'и')
  // «Данный/Данная/…» → «этот/эта/…» (падеж совпадает).
  t = t.replace(new RegExp(`${NB}данн(?:ый|ая|ое|ого|ой|ом|ую)${NA}`, 'gi'), m => matchCase(DAN[m.toLowerCase()] || m, m))
  // Копула «является»: «не является X» → «не X»; иначе → « — » (легальный em-dash).
  t = t.replace(new RegExp(`${NB}не\\s+явля(?:ется|ются)\\s+`, 'gi'), 'не ')
  t = t.replace(new RegExp(`\\s*${NB}явля(?:ется|ются)${NA}\\s*`, 'gi'), ' — ')
  return t
}
async function walkMd(dir, since, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.includes('graphify-out')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkMd(full, since, acc)
    else if (e.name.endsWith('.md')) acc.push(full)
  }
  return acc
}
// Розетка run.mjs МЕЖДУ генерацией ноты и sweep: очеловечивает свежие ноты ДО
// сторожа, чтобы конвейер не падал о собственный гейт. На каждую свежую ноту:
// гейт (слоп?) → автоправка deslop → повторный гейт; не чинится за 2 итерации →
// прогон честно падает 1 с именем ноты. Правку принимаем, только если факты целы
// (preservationCheck clean:false — «до» ⊆ «после») И слоп снят. Sweep остается
// байтовым бэкстопом после паса.
async function runPass() {
  const vault = resolveVault({ cli: arg('vault') })
  const since = arg('changed-since', '')
  const sinceMs = since ? (Number.isFinite(Date.parse(since)) ? Date.parse(since) : Number(since)) : 0
  const files = await walkMd(vault, sinceMs)
  const fixed = []
  const failures = []
  let checked = 0
  for (const f of files) {
    const rel = path.relative(vault, f)
    if (isServicePath(rel)) continue
    if (sinceMs && (await fs.stat(f)).mtimeMs < sinceMs) continue
    const text = await fs.readFile(f, 'utf8')
    if (slopOf(text) === 0) continue // em-dash / низкий score — не наша забота (advisory sweep)
    checked += 1
    let cand = text
    let cleared = false
    // Две итерации автоправки (deslop идемпотентен, но структура держит спецификацию
    // и оставляет шов под LLM-эскалацию на 2-й проход).
    for (let iter = 0; iter < 2 && !cleared; iter++) {
      const next = deslop(cand)
      let g
      try { g = preservationCheck(text, next, { clean: false }) } // факты «до» ⊆ «после»
      catch (err) { failures.push({ file: rel, reason: `preservation input: ${err.message}` }); cleared = false; break }
      if (g.code !== 0) break // правка тронула факт/байт-блок — бросаем кандидата, нота как была
      cand = next
      if (slopOf(cand) === 0) cleared = true
    }
    if (cleared) {
      if (cand !== text) await fs.writeFile(f, cand, 'utf8')
      fixed.push(rel)
    } else {
      const bans = runScanner(proseForScan(cand)).hard_bans.filter(([n]) => n !== EM_DASH_BAN)
      failures.push({ file: rel, slop_ban_count: slopOf(cand), hard_bans: bans })
    }
  }
  const payload = { ok: !failures.length, checked, fixed, failures }
  if (failures.length) { console.error(JSON.stringify(payload, null, 2)); return 1 }
  console.log(JSON.stringify(payload, null, 2))
  return 0
}

async function runSweep() {
  // Розетка run.mjs: читаемость нот, измененных с runStartedAt. Фатален СЛОП —
  // hard bans КРОМЕ «Длинное тире» (является/в современном мире/комплексный подход):
  // свежая нота из очеловеченного конвейера их нести не должна. Длинное тире сквозное
  // в корпусе (95% всех hard bans — даты и заголовки), потому advisory, не фатал —
  // иначе сторож краснит каждый живой прогон, а это тот же провал, что дыра.
  // Низкий score тоже advisory, фатал только при MNEMAZINE_HUMANIZE_STRICT=1.
  // ponytail: апгрейд — снять em-dash из корпуса кампанией, тогда включить его в фатал.
  const vault = resolveVault({ cli: arg('vault') })
  const since = arg('changed-since', '')
  const sinceMs = since ? (Number.isFinite(Date.parse(since)) ? Date.parse(since) : Number(since)) : 0
  const porog = Number(arg('porog', String(POROG_DEFAULT)))
  const strict = process.env.MNEMAZINE_HUMANIZE_STRICT === '1'
  const files = await walkMd(vault, sinceMs)
  const failures = []
  const advisories = []
  let checked = 0
  for (const f of files) {
    const rel = path.relative(vault, f)
    if (isServicePath(rel)) continue
    if (sinceMs && (await fs.stat(f)).mtimeMs < sinceMs) continue
    checked += 1
    const text = await fs.readFile(f, 'utf8')
    const c = runScanner(proseForScan(text))
    const fatal = c.slop_ban_count > 0 || (strict && c.score < porog)
    if (fatal) failures.push({ file: rel, score: c.score, slop_ban_count: c.slop_ban_count, hard_bans: c.hard_bans })
    else if (c.hard_ban_count > 0 || c.score < porog) advisories.push({ file: rel, score: c.score, em_dash_only: c.slop_ban_count === 0 })
  }
  const payload = { ok: !failures.length, checked, strict, porog, failures, advisories_count: advisories.length }
  if (failures.length) { console.error(JSON.stringify(payload, null, 2)); return 1 }
  console.log(JSON.stringify(payload, null, 2))
  return 0
}

async function main() {
  try {
    if (has('selftest')) return await runSelftest()
    if (has('baseline')) return await runBaseline()
    if (has('pass')) return await runPass()
    if (has('sweep')) return await runSweep()
    return await runPair()
  } catch (err) {
    if (err instanceof InputError) { console.error(`[вход] ${err.message}`); return 2 }
    console.error(`[сбой] ${err.stack || err.message}`); return 2
  }
}

// Только как CLI. Импорт (preservationCheck из digest) не должен запускать main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
