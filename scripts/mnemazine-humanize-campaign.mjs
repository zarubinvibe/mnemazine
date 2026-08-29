#!/usr/bin/env node
// План П13 шаг 8 — кампания очеловечивания корпуса партиями по 50 нот.
// Каждая партия: git-коммит vault ДО, рерайт нот, гейт сохранности на КАЖДОЙ ноте,
// git-коммит ПОСЛЕ. Не прошедший гейт вариант отбрасывается — в vault остается
// исходник (ни одна нота не удаляется). Первая партия — худшие по cleanliness из
// базового замера (--worst-first). СТОП: три партии подряд без роста медианы → разбор.
//
//   node scripts/mnemazine-humanize-campaign.mjs --limit 50 --worst-first      # dry-run: план
//   node scripts/mnemazine-humanize-campaign.mjs --limit 50 --apply            # рерайт + коммиты
//
// БЕЗ --apply НИЧЕГО не пишет и не коммитит. --apply требует доступного LLM и
// точки отката П15 (live vault уже под контролем версий).
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { preservationCheck } from './mnemazine-humanize-gate.mjs'
import { activeProvider, llmAvailable, llmText, fenceUntrusted } from './mnemazine-llm.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
function arg(name, fb = '') {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fb
  const v = argv[i + 1]
  return (v && !v.startsWith('--')) ? v : fb
}
const has = name => argv.includes(`--${name}`)

const VAULT = resolveVault({ cli: arg('vault') })
const BASELINE = arg('baseline', '.mnemazine/state/humanize-baseline.json')
const LIMIT = Number(arg('limit', '50'))
const APPLY = has('apply')
const REPORT_DIR = arg('report-dir', 'reports/campaigns')

// Рерайт одной ноты: только проза блоков 1-7, неприкасаемые зоны — дословно.
// Гейт все равно проверит; промпт лишь повышает шанс пройти.
function humanizePrompt(text) {
  return `Ты очеловечиваешь заметку знаний на РУССКОМ. Верни ВЕСЬ текст заметки целиком, без преамбул и без обертки в тройные кавычки.

Правь ТОЛЬКО прозу тела. НЕ трогай (переноси дословно, байт в байт):
- YAML-frontmatter между --- ... ---;
- блоки кода в тройных кавычках и инлайн-код в одиночных обратных кавычках;
- раздел «## Достоверность» целиком;
- таблицы и цитаты (строки, начинающиеся с > );
- все числа, ссылки http(s)://, пути, [[wikilinks]], версии, даты, латинские названия инструментов.

Сделай прозу живой и ясной: убери канцелярит, номинализации, воду. Никаких длинных тире «—» (используй дефис или запятую), никакого «является», «в современном мире», «комплексный подход». Не добавляй фактов сверх заметки.

Заметка:
${fenceUntrusted('НОТА', text)}`
}

async function humanizeNote(text) {
  const out = await llmText(humanizePrompt(text), { provider: activeProvider() })
  // Снять возможную обертку в тройные кавычки.
  return out.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```\s*$/m, '$1').trim() + '\n'
}

function git(args) { return spawnSync('git', ['-C', VAULT, ...args], { encoding: 'utf8' }) }

function loadBatch() {
  if (!existsSync(BASELINE)) throw new Error(`нет базового замера: ${BASELINE} (сними --baseline у гейта)`)
  const b = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const worst = Array.isArray(b.worst) ? b.worst : []
  return worst.slice(0, LIMIT) // worst уже отсортирован по возрастанию score
}

async function main() {
  const batch = loadBatch()
  if (!batch.length) { console.error('пустая очередь: worst[] в базовом замере пуст'); return 1 }

  if (!APPLY) {
    console.log(JSON.stringify({
      mode: 'dry-run', apply: false, vault: VAULT, batch_size: batch.length,
      worst_score_range: [batch[0]?.score, batch[batch.length - 1]?.score],
      note: 'без --apply ничего не пишется и не коммитится. Запуск кампании — крупная LLM-мутация vault, только по явному решению владельца и после точки отката П15.',
      first5: batch.slice(0, 5).map(x => ({ score: x.score, note: path.basename(x.path) }))
    }, null, 2))
    return 0
  }

  // --apply: реальная мутация корпуса.
  if (!llmAvailable()) { console.error('нет доступного LLM-провайдера — рерайт невозможен'); return 2 }
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) { console.error(`${VAULT} не под git — точки отката нет`); return 2 }

  const stamp = arg('now', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'))
  git(['add', '-A']); git(['commit', '-m', `humanize-campaign П13: до партии (${stamp})`])

  const diffs = []; let rewritten = 0, kept = 0
  for (const item of batch) {
    const file = item.path
    if (!existsSync(file)) { kept += 1; continue }
    const before = await fs.readFile(file, 'utf8')
    let cand
    try { cand = await humanizeNote(before) } catch (err) { diffs.push({ note: path.basename(file), rejected: `llm: ${err.message}` }); kept += 1; continue }
    const g = preservationCheck(before, cand, { clean: true })
    if (g.code === 0) {
      await fs.writeFile(file, cand, 'utf8')
      rewritten += 1
      // прием 24: машинно снимаемый след правки — проза до/после в отчет партии.
      diffs.push({ note: path.basename(file), score_before: item.score, score_after: g.cleanliness?.score, applied: true })
    } else {
      kept += 1
      diffs.push({ note: path.basename(file), rejected: g.dirty ? `грязь score=${g.cleanliness?.score}` : `потеря ${g.lost.length} инвариантов`, lost: g.lost.slice(0, 5) })
    }
  }

  git(['add', '-A']); git(['commit', '-m', `humanize-campaign П13: после партии (${stamp}), переписано ${rewritten}, оставлено ${kept}`])

  await fs.mkdir(path.resolve(REPORT_DIR), { recursive: true })
  const report = path.join(REPORT_DIR, `humanize-campaign-${stamp}.md`)
  await fs.writeFile(report, [
    `# Партия очеловечивания П13 — ${stamp}`,
    '', `Vault: \`${VAULT}\` · нот в партии: ${batch.length} · переписано: **${rewritten}** · оставлено исходником: **${kept}**.`,
    '', 'Гейт сохранности отверг варианты с потерей фактов — в vault остался исходник.',
    '', '## След правки (прием 24)', '', '```json', JSON.stringify(diffs, null, 2), '```'
  ].join('\n') + '\n', 'utf8')

  console.log(JSON.stringify({ mode: 'apply', batch: batch.length, rewritten, kept, report }, null, 2))
  console.error('НАПОМИНАНИЕ (стоп-критерий шаг 8): пересними базовый замер; если после трех партий медиана не выросла — останови кампанию на разбор.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main().catch(err => { console.error(err.stack || err.message); return 2 }))
}
