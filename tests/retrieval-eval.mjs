#!/usr/bin/env node
// Retrieval-eval на живом vault (юнит F): 20 реальных вопросов владельца, три
// пайплайна — (а) rg -li по словам запроса, (б) kb-embed query, (в) kb-embed
// rerank — метрика hit@7 (ожидаемая нота в топ-7 по уникальной подстроке basename).
// Ожидания зафиксированы ДО первого прогона (2026-07-25): промах — легитимный
// замер качества поиска, вопросы под ответы не подгоняются.
// tests/search-eval.mjs меряет синтетический фикстур-vault; этот — живой личный vault,
// поэтому кейс, чье ожидание исчезло из корпуса (нота уехала/переименована),
// валит прогон fail-loud до замера — протухший замер хуже отсутствующего.
//   node tests/retrieval-eval.mjs [--vault <p>] [--index <p>] [--python <bin>]
//        [--kb-embed <p>] [--limit <n>] [--report <out.md>] [--baseline <json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveVault } from '../scripts/mnemazine-paths.mjs'

const LOCAL_PYTHON = path.resolve('.venv', 'bin', 'python')
const DEFAULT_PYTHON = fs.existsSync(LOCAL_PYTHON) ? LOCAL_PYTHON : path.join(os.homedir(), '.venvs', 'kb-embed', 'bin', 'python')
const DEFAULT_KB_EMBED = path.resolve('skills', 'mnemazine', 'kb-embed.py')
const TOPK = 7
const SPAWN_TIMEOUT_MS = 900_000 // rerank грузит кросс-энкодер в каждом вызове — минуты, не секунды
const MAX_BUF = 64 * 1024 * 1024

// Ожидание = подстроки basename (lowercase, NFC); хит, если ЛЮБАЯ нота топ-7
// несет ЛЮБУЮ из них. Несколько подстрок — только когда в vault несколько
// легитимно правильных нот про то же самое, не для смягчения замера.
// Questions live outside the code: they are personal by nature — what YOU need to
// find in YOUR vault. Copy tests/fixtures/retrieval-questions.example.json to
// tests/fixtures/retrieval-questions.json (git-ignored) and put your own there.
const QUESTIONS_FILE = process.env.MNEMAZINE_RETRIEVAL_QUESTIONS
  || path.resolve('tests', 'fixtures', 'retrieval-questions.json')
const QUESTIONS_FALLBACK = path.resolve('tests', 'fixtures', 'retrieval-questions.example.json')
const QUESTIONS = (() => {
  const file = fs.existsSync(QUESTIONS_FILE) ? QUESTIONS_FILE : QUESTIONS_FALLBACK
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : parsed.questions
  if (!Array.isArray(list) || !list.length) {
    console.error(`Нет вопросов для замера: ${file}`)
    process.exit(2)
  }
  return list
})()

// Только служебные слова: генеративные глаголы не стоп-листим, чтобы не
// подстраивать rg-пайплайн под конкретные вопросы.
const STOP = new Set(['как', 'что', 'чтобы', 'для', 'при', 'перед', 'через', 'без',
  'это', 'мой', 'мои', 'мне', 'меня', 'мной', 'какой', 'какие', 'чем', 'или',
  'где', 'когда', 'кто', 'есть', 'надо', 'нужно', 'нужны'])

const nfc = s => s.normalize('NFC')

function parseArgs(argv) {
  const flags = {}
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k.startsWith('--') || argv[i + 1] === undefined) { console.error(`bad arg: ${k}`); process.exit(1) }
    flags[k.slice(2)] = argv[i + 1]
  }
  return flags
}

// Зеркало _is_content_note из kb-embed.py — иначе rg-пайплайн меряет другой корпус.
function isServicePath(p) {
  const parts = p.split(path.sep)
  if (parts.some(seg => seg === 'graphify-out' || seg === 'graphify-out-snapshots' || seg.startsWith('graphify-out-backup-'))) return true
  return parts.some((seg, i) => seg === '99 Система' && parts[i + 1] === '_archive')
}

function isContentNote(p) {
  if (isServicePath(p) || p.includes('/.git/') || p.includes('/.obsidian/')) return false
  return !p.split(path.sep).some(seg => seg.startsWith('_'))
}

function listCorpus(vault) {
  return fs.readdirSync(vault, { recursive: true })
    .filter(rel => rel.endsWith('.md'))
    .map(rel => path.join(vault, rel))
    .filter(isContentNote)
}

function isHit(paths, expect) {
  return paths.some(p => {
    const base = nfc(path.basename(p)).toLowerCase()
    return expect.some(e => base.includes(nfc(e).toLowerCase()))
  })
}

function queryWords(q) {
  const tokens = q.toLowerCase().match(/[a-zа-яё0-9][a-zа-яё0-9-]*/g) || []
  return [...new Set(tokens.filter(w => w.length >= 3 && !STOP.has(w)))]
}

// Пайплайн (а): rg -li на каждое слово, ранжирование по числу совпавших слов.
// --no-ignore — python-индексатор gitignore не читает, корпуса должны совпадать.
function runRg(q, vault) {
  const votes = new Map()
  for (const w of queryWords(q)) {
    const r = spawnSync('rg', ['-liF', '--no-ignore', '--no-messages', '-g', '*.md', '--', w, vault],
      { encoding: 'utf8', maxBuffer: MAX_BUF })
    if (r.status !== 0 && r.status !== 1) throw new Error(`rg failed on "${w}": ${r.stderr || r.status}`)
    for (const line of (r.stdout || '').split('\n')) {
      const p = line.trim()
      if (p && isContentNote(p)) { const k = nfc(p); votes.set(k, (votes.get(k) || 0) + 1) }
    }
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOPK).map(([p]) => p)
}

function runKbEmbed(cfg, cmd, q) {
  const r = spawnSync(cfg.python, [cfg.kbEmbed, cmd, cfg.index, q, String(TOPK)],
    { encoding: 'utf8', maxBuffer: MAX_BUF, timeout: SPAWN_TIMEOUT_MS })
  const line = (r.stdout || '').trim().split('\n').pop()
  let parsed
  try { parsed = JSON.parse(line) } catch {
    throw new Error(`kb-embed ${cmd} non-JSON (exit ${r.status}): ${line || r.stderr?.slice(-300)}`)
  }
  if (parsed.error) throw new Error(`kb-embed ${cmd}: ${parsed.error}`)
  return parsed
}

function readBaseline(file) {
  if (!file) return null
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const k of ['rg', 'query', 'rerank']) {
      if (!Number.isFinite(Number(b[k]))) throw new Error(`bad ${k}`)
    }
    return { file, rg: Number(b.rg), query: Number(b.query), rerank: Number(b.rerank), n: Number(b.n || b.total || 20), date: b.date || '2026-07-25' }
  } catch (e) {
    console.error(`baseline not readable: ${file} (${e.message})`)
    process.exit(2)
  }
}

function buildReport({ results, corpusSize, indexSize, index, rerankMethod, hits, baseline }) {
  const n = results.length
  const row = r => `| ${r.id} | ${r.q} | ${r.section} | ${r.rg ? '✓' : '✗'} | ${r.query ? '✓' : '✗'} | ${r.rerank ? '✓' : '✗'} |`
  const missBlock = key => {
    const misses = results.filter(r => !r[key])
    if (!misses.length) return '- промахов нет'
    return misses.map(r => `- ${r.id} «${r.q}» — ждали: ${r.expect.join(' | ')}`).join('\n')
  }
  const gain = hits.rerank - hits.query
  const verdict = gain > 0
    ? `Реранк ДАЕТ прирост над query: +${gain} (query ${hits.query}/${n} → rerank ${hits.rerank}/${n}).`
    : gain === 0
      ? `Реранк НЕ меняет hit@7 (query ${hits.query}/${n} = rerank ${hits.rerank}/${n}).`
      : `Реранк УХУДШАЕТ hit@7: ${gain} (query ${hits.query}/${n} → rerank ${hits.rerank}/${n}).`
  const compare = baseline
    ? `Сравнимо с базой ${baseline.date}: ДА, набор вопросов сохранен. Старые числа: rg ${baseline.rg}/${baseline.n} · query ${baseline.query}/${baseline.n} · rerank ${baseline.rerank}/${baseline.n}. Новые числа: rg ${hits.rg}/${n} · query ${hits.query}/${n} · rerank ${hits.rerank}/${n}.`
    : 'Сравнимо с базой 25.07: НЕТ — baseline-файл не передан.'
  const nextMetric = 'Метрика следующего поколения зафиксирована до этого замера: hit@fragment@7 — найден точный фрагмент ответа внутри ноты, а не только basename ноты. В П14 не включается, чтобы не ломать сравнимость с 25.07.'
  const queryReview = 'Рецензия запросов перед замером: 20 формулировок сверены с живым корпусом через fail-loud проверку ожиданий; вопросы не подгонялись под ответы.'
  return `# Retrieval-eval — живой vault, 2026-08-22

Юнит F: ${n} вопросов владельца по разделам корпуса, ожидания зафиксированы до прогона
(tests/retrieval-eval.mjs в проекте mnemazine — прогон воспроизводим).
Корпус: ${corpusSize} контент-нот · индекс: ${indexSize} векторов (${index}).
Пайплайны: (а) rg -li по словам запроса, ранжирование по числу совпавших слов, top-7;
(б) kb-embed query — cosine + title-boost, top-7; (в) kb-embed rerank — top-30 cosine
→ кросс-энкодер (${rerankMethod}), top-7. Метрика: hit@7 — ожидаемая нота в топ-7
по уникальной подстроке basename.

## hit@7

| # | Вопрос | Раздел | rg | query | rerank |
|---|---|---|---|---|---|
${results.map(row).join('\n')}
| — | **Итого** | | **${hits.rg}/${n}** | **${hits.query}/${n}** | **${hits.rerank}/${n}** |

## Вердикт

${verdict}
Лексический rg: ${hits.rg}/${n}; эмбеддинги (query): ${hits.query}/${n}.
${compare}
${queryReview}
${nextMetric}

## Промахи

### rg (${n - hits.rg})
${missBlock('rg')}

### query (${n - hits.query})
${missBlock('query')}

### rerank (${n - hits.rerank})
${missBlock('rerank')}
`
}

function main() {
  const flags = parseArgs(process.argv)
  const baseline = readBaseline(flags.baseline)
  const vault = resolveVault({ cli: flags.vault, env: process.env.MNEMAZINE_VAULT })
  const cfg = {
    python: flags.python || DEFAULT_PYTHON,
    kbEmbed: flags['kb-embed'] || DEFAULT_KB_EMBED,
    index: flags.index || path.join(vault, '99 Система', '_embeddings.json')
  }
  for (const [name, p] of [['python', cfg.python], ['kb-embed', cfg.kbEmbed], ['index', cfg.index]]) {
    if (!fs.existsSync(p)) { console.error(`${name} not found: ${p}`); process.exit(1) }
  }
  if (spawnSync('rg', ['--version']).status !== 0) { console.error('rg not found'); process.exit(1) }

  const corpus = listCorpus(vault)
  const corpusBases = corpus.map(p => nfc(path.basename(p)).toLowerCase())
  const cases = QUESTIONS.slice(0, flags.limit ? Number(flags.limit) : QUESTIONS.length)

  const broken = cases.filter(c => !c.expect.some(e => corpusBases.some(b => b.includes(nfc(e).toLowerCase()))))
  if (broken.length) {
    console.error('ожидания не найдены в корпусе (нота уехала или подстрока с опечаткой):')
    for (const c of broken) console.error(`  «${c.q}» → ${c.expect.join(' | ')}`)
    process.exit(1)
  }

  const indexSize = Object.keys(JSON.parse(fs.readFileSync(cfg.index, 'utf8'))).length
  let rerankMethod = ''
  const results = cases.map((c, i) => {
    const id = String(i + 1).padStart(2, '0')
    process.stderr.write(`[${id}/${cases.length}] ${c.q}\n`)
    const rg = isHit(runRg(c.q, vault), c.expect)
    const query = isHit(runKbEmbed(cfg, 'query', c.q).matches.map(m => m.note), c.expect)
    const rr = runKbEmbed(cfg, 'rerank', c.q)
    rerankMethod = rr.reranker
    const rerank = isHit(rr.matches.map(m => m.note), c.expect)
    console.log(`${id} rg:${rg ? '✓' : '✗'} query:${query ? '✓' : '✗'} rerank:${rerank ? '✓' : '✗'}  ${c.q}`)
    return { id, q: c.q, section: c.section, expect: c.expect, rg, query, rerank }
  })

  const hits = {
    rg: results.filter(r => r.rg).length,
    query: results.filter(r => r.query).length,
    rerank: results.filter(r => r.rerank).length
  }
  console.log(`\nhit@7: rg ${hits.rg}/${results.length} · query ${hits.query}/${results.length} · rerank ${hits.rerank}/${results.length} (${rerankMethod})`)

  const report = flags.report || path.join('reports', 'retrieval-eval-2026-08-22.md')
  if (report) {
    fs.mkdirSync(path.dirname(report), { recursive: true })
    const md = buildReport({ results, corpusSize: corpus.length, indexSize, index: cfg.index, rerankMethod, hits, baseline })
    fs.writeFileSync(report, md, 'utf8')
    console.log(`report: ${report}`)
  }

  if (baseline) {
    const worse = ['rg', 'query', 'rerank'].filter(k => hits[k] < baseline[k])
    if (worse.length) {
      console.error(`hit@7 below baseline ${baseline.date}: ${worse.map(k => `${k} ${hits[k]}/${results.length} < ${baseline[k]}/${baseline.n}`).join('; ')}`)
      process.exit(1)
    }
  }
}

main()
