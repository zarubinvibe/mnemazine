#!/usr/bin/env node
// ВОРОТА ПОЛНОТЫ — кодом, а не суждением агента.
//
// Зачем: 2026-07-25 прогон kb-20260725201732 закрылся маркером «ПОКРЫТИЕ ПОЛНОЕ ✓», ledger
// unaccounted=0, archived=73 — при том что на диске файл `tmpImage_8B654E2A-…JPG` не имел НИ ноты,
// НИ OCR-сайдкара, НИ записи причины (а Apple Vision читает его: 1193 символа про OmniRoute), и 72 из 73
// файлов остались в инбоксе неархивированными. Сверщик — LLM, которая сама грепает и сама выносит
// вердикт; в том же прогоне она еще и чинила собственный баг грепа по ходу проверки. Это generator≈verifier
// на самом важном гейте системы.
//
// Подсчет покрытия — не суждение, а греп. Значит его место в коде с кодом возврата. LLM остается то,
// что действительно требует головы: КАКАЯ причина у дыры (дубль/шум/нечитаемо) — но только после того,
// как список дыр посчитан детерминированно.
//
// Контракт: exit 0 = каждый файл НЕПУСТОЙ переписи покрыт; exit 1 = есть дыры (список в JSON);
// exit 2 = ошибка ввода ИЛИ пустая перепись без --allow-empty. Пустая перепись — не «сдано 0/0 ✓»:
// ворота полноты, написанные после инцидента 25.07, обязаны краснеть на нулевом входе, иначе
// возвращают ровно тот зеленый, что мастер-план §8 запрещает прибору оркестрации.
// Покрытым считается файл, чей basename встречается в теле или frontmatter хотя бы одной ноты vault —
// та же семантика, что у сверщика (`source:`/`sources:`), но без права ошибиться в регулярке.
// Для переименованных job snapshots дополнительно считается SHA-256 текущего файла:
// local-media hash засчитывается только из final verified enriched ноты (strictKnowledgeReady).
import { promises as fs } from 'node:fs'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'
import { strictKnowledgeReady } from './mnemazine-note-spec.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

/** Ноты vault одним чтением: корпус мал (< 20 МБ), а N грепов по файлу — это N спавнов и гонка. */
async function readCorpus(vault) {
  const chunks = []
  const verifiedRefs = new Set()
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['.git', '.obsidian', '.mnemazine'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      const p = path.join(dir, item.name)
      if (item.isDirectory()) await walk(p)
      else if (item.isFile() && p.endsWith('.md')) {
        const text = await fs.readFile(p, 'utf8')
        chunks.push(text)
        if (strictKnowledgeReady(text)) {
          for (const match of text.matchAll(/\blocal-media:([a-f0-9]{64}|[a-f0-9]{16})(?![a-f0-9])/gi)) verifiedRefs.add(match[1].toLowerCase())
        }
      }
    }
  }
  await walk(vault)
  return { text: chunks.join('\n'), verifiedRefs }
}

/**
 * Файл покрыт, если его basename дословно встречается в корпусе.
 * NFC-нормализация обязательна: macOS отдает имена файлов в NFD («й» = «и»+U+0306), а нота пишется из
 * контекста агента в NFC — без выравнивания кириллическое имя дает ложную дыру на каждом прогоне.
 */
export function isCovered(corpusNfc, filePath) {
  return corpusNfc.includes(path.basename(filePath).normalize('NFC'))
}

if (argv.includes('--selftest')) {
  const { strictEqual: eq } = await import('node:assert')
  // «й» и «ё» — единственные кириллические буквы, которые NFD реально расщепляет (и + U+0306). Имя без
  // них делает NFD-проверку пустой: первая версия этого теста брала «Заметка Кирилла», где NFD == NFC,
  // и мутация «убрать normalize» проходила незамеченной. Тест обязан содержать расщепляемую букву.
  const nfdName = 'Андрей — елка.md'
  const corpus = ['source: IMG_1.PNG', 'sources:', '  - ' + nfdName].join('\n').normalize('NFC')
  eq(nfdName.normalize('NFD') !== nfdName.normalize('NFC'), true) // страховка: имя действительно расщепляется
  eq(isCovered(corpus, '/inbox/IMG_1.PNG'), true)
  eq(isCovered(corpus, '/inbox/IMG_2.PNG'), false) // отсутствующий файл обязан считаться дырой
  // NFD-имя с диска против NFC-корпуса: без нормализации это ложная дыра.
  eq(isCovered(corpus, '/inbox/' + nfdName.normalize('NFD')), true)
  eq(isCovered('', '/inbox/IMG_1.PNG'), false) // пустой корпус не покрывает ничего
  console.log('selftest ok')
  process.exit(0)
}

const VAULT = resolveVault({ cli: arg('vault') })
// Перепись: либо --census <json-файл со списком путей>, либо все файлы инбокса верхнего уровня.
const censusFile = arg('census')
let census
if (censusFile) {
  const raw = JSON.parse(await fs.readFile(censusFile, 'utf8'))
  census = Array.isArray(raw) ? raw : (raw.files || raw.paths || [])
  if (!Array.isArray(census)) { console.error('census: ожидался массив путей'); process.exit(2) }
} else {
  const inbox = arg('inbox', path.join(process.env.HOME || '', 'Desktop', 'Mnemazine Inbox'))
  const items = await fs.readdir(inbox, { withFileTypes: true }).catch(() => null)
  if (!items) { console.error(`инбокс не найден: ${inbox}`); process.exit(2) }
  // Только обычные файлы верхнего уровня: _archive/_work/.ocr/.staging — служебные каталоги прогона,
  // они не материал и не обязаны иметь ноту.
  census = items.filter(i => i.isFile() && !i.name.startsWith('.')).map(i => path.join(inbox, i.name))
}

if (census.length === 0 && !argv.includes('--allow-empty')) {
  console.error('перепись пуста: 0 файлов на проверку покрытия (--allow-empty чтобы разрешить)')
  process.exit(2)
}

const corpus = await readCorpus(VAULT)
const corpusNfc = corpus.text.normalize('NFC')
const uncovered = []
for (const file of census) {
  if (isCovered(corpusNfc, file)) continue
  let coveredByHash = false
  if (corpus.verifiedRefs.size) {
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const hash = createHash('sha256')
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Source is not a regular file')
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      } finally { await handle.close() }
      const digest = hash.digest('hex')
      coveredByHash = corpus.verifiedRefs.has(digest) || corpus.verifiedRefs.has(digest.slice(0, 16))
    } catch { /* Unreadable sources cannot be proven covered by content. */ }
  }
  if (!coveredByHash) uncovered.push(file)
}
const report = { ok: uncovered.length === 0, vault: VAULT, census: census.length, covered: census.length - uncovered.length, uncovered }

if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`перепись ${report.census} · покрыто ${report.covered} · дыр ${uncovered.length}`)
  for (const f of uncovered) console.log(`  ДЫРА ${path.basename(f)}`)
}
process.exit(uncovered.length ? 1 : 0)
