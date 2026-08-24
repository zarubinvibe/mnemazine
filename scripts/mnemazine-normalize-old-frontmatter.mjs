#!/usr/bin/env node
// Механическая половина переогранки старого корпуса под docs/NOTE-SPEC.md — за $0, детерминированно.
//
// Зачем отдельно от Кими-кампании: из 1378 нот, валящих `--spec`, 1361 валит `type` и 1250 `verified`, и
// это ЧИСТОЕ переименование словаря (`knowledge-note` → `concept`), а не суждение. Гонять на него LLM —
// платить за regex. Кими остаётся то, что действительно требует головы: блоки «Как это поможет мне» и
// «Достоверность», плотность текста, доля кириллицы, мерж-вердикт.
//
// Что скрипт НЕ делает принципиально:
//   • не выдумывает `source` — провенанс нельзя восстановить угадыванием (только переносит из `sources`);
//   • не ставит `подтверждён` там, где проверки не было (для этого владелец завёл «не-проверялось»);
//   • не трогает тело ноты вообще;
//   • не создаёт frontmatter с нуля — нота без него уходит в отчёт, её чинит конвейер.
//
// Правка построчная, а не через reparse+dump: пересборка YAML переформатировала бы 1378 файлов целиком и
// потеряла бы комментарии/порядок. Дубль ключа во frontmatter — уже измеренная дыра проекта, поэтому файл
// с дублем `type`/`verified` не правится, а уходит в отчёт (fail-closed).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEC_TYPES, SPEC_VERIFIED, normSpecValue } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'

const norm = s => normSpecValue(String(s ?? '').trim())
const CANON_VERIFIED = new Map([...SPEC_VERIFIED].map(v => [norm(v), v]))

/**
 * Старый словарь типов — 184 разных значения на 1378 нот. Отображение по СУФФИКСУ, а не таблицей на 184
 * строки: словарь рос свободно (`security-tool-reference`, `frontend-quality-gate`), и таблица отстала бы
 * от следующей волны. Умолчание — `concept`: спека определяет его как «понятие/метод/принцип», под что
 * ложатся все `*-method`, `*-boundary`, `*-policy`, `*-gate`, `*-atom`, `workflow`, `prompt`.
 *
 * Куда НЕ отображаем механически:
 *   `decision`  — требует непустые `context` и `rejected`, их у старых нот нет: гейт всё равно провалит;
 *   `tool-card` — требует repo/stars/license/risk; ставим ТОЛЬКО когда все четыре реально в ноте.
 * Оригинал сохраняется в `type_legacy` — это вход для Кими (`security-tool-reference` говорит ей о ноте
 * больше, чем выровненный `concept`), и страховка от неверного отображения.
 */
export function mapType(old, data) {
  const has = k => {
    const v = data[k]
    return Array.isArray(v) ? v.length > 0 : Boolean(String(v ?? '').trim())
  }
  if (has('repo') && has('stars') && has('license') && has('risk')) return 'tool-card'
  const t = norm(old)
  if (SPEC_TYPES.has(t) && t !== 'decision' && t !== 'tool-card') return t
  if (/(^|-)(reference|catalog|index|map|list|queue)$/.test(t) || t === 'redirect') return 'reference'
  if (/(synthesis|canonical-summary|digest|overview|comparison|stack|triage)/.test(t)) return 'synthesis'
  return 'concept'
}

/**
 * Старое значение `verified` → enum спеки. Правило одно: НИКОГДА не заявлять проверку, которой не было.
 * Порядок проверок — от точного к общему:
 *   1. значение УЖЕ из enum → оно же, без legacy.
 *   2. enum + аннотация через пробел или скобку («непроверяемо-методом (транскрипт видео)») → enum,
 *      аннотация в `verified_legacy`. Без этого шага 35 честных значений понижались в «не-проверялось»
 *      просто потому, что автор дописал скобку — измерено на живом корпусе. Граница обязательна: без неё
 *      «непроверяемо-методомX» тоже сошло бы за валидное значение.
 *   3. да/true/подтверждено… → `подтверждён` (прошлый конвейер именно это и утверждал). Оговорка о
 *      неполноте бьёт утверждение сама собой: «частично подтверждено…» начинается не с «подтвержд»,
 *      поэтому сюда не попадает и уезжает в общий случай — отдельная ветка на «частично» была бы мёртвым
 *      кодом (проверено мутацией: её удаление не меняет ни одного исхода).
 *   4. expanded with public sources → `подтверждён`: старый конвейер уже расширил ноту публичными
 *      источниками, то есть это проверка источниками, а не пустая догадка.
 *   5. пусто/false/нет → `не-проверялось` без legacy: терять нечего.
 *   6. всё прочее — «частично…», даты, свободный текст → `не-проверялось`, оригинал в legacy.
 *      Занижение безопаснее завышения: непроверенное знание, помеченное проверенным, — худший исход.
 */
export function mapVerified(old) {
  const v = norm(old)
  if (CANON_VERIFIED.has(v)) return { value: CANON_VERIFIED.get(v), keepLegacy: false }
  for (const [canon, value] of CANON_VERIFIED) {
    if (v.startsWith(canon) && /^[\s(]/.test(v.slice(canon.length))) return { value, keepLegacy: true }
  }
  if (/^(да|true|yes|verified)$/.test(v) || /^подтвержд/.test(v)) return { value: 'подтверждён', keepLegacy: v !== 'подтвержден' }
  if (v === 'expanded with public sources') return { value: 'подтверждён', keepLegacy: true }
  if (!v || /^(false|no|нет|null|undefined)$/.test(v)) return { value: 'не-проверялось', keepLegacy: false }
  return { value: 'не-проверялось', keepLegacy: true } // даты, свободный текст — информацию храним
}

// Основное тело исполняется ТОЛЬКО при прямом вызове: прибор миграционного контракта
// (mnemazine-migration-check.mjs) импортирует mapType/mapVerified, и без этого стража
// импорт запускал бы обход vault и правки по чужим argv.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain && process.argv.slice(2).includes('--selftest')) {
  const { strictEqual: eq } = await import('node:assert')
  const V = s => mapVerified(s).value
  // Аннотация не понижает честное значение (баг, найденный на живом корпусе — 35 нот).
  eq(V('непроверяемо-методом (транскрипт видео)'), 'непроверяемо-методом')
  eq(mapVerified('непроверяемо-методом (транскрипт видео)').keepLegacy, true)
  // Оговорка о неполноте бьёт слово «подтверждено» — иначе частичная проверка выдаст себя за полную.
  // Без границы «непроверяемо-методомX» сошло бы за валидное значение — мутация ловится ровно этим.
  eq(V('непроверяемо-методомX'), 'не-проверялось')
  eq(V('частично подтверждено первоисточниками 2026-06-06'), 'не-проверялось')
  eq(V('частично-подтверждено'), 'не-проверялось')
  eq(V('подтверждено на дату предыдущей проверки'), 'подтверждён')
  eq(V('подтверждён'), 'подтверждён')
  eq(V('подтвержден'), 'подтверждён') // ё/е — одно слово
  eq(V('true'), 'подтверждён')
  eq(V('expanded with public sources'), 'подтверждён')
  eq(mapVerified('expanded with public sources').keepLegacy, true)
  eq(V('false'), 'не-проверялось')
  eq(V(''), 'не-проверялось')
  eq(V('2026-06-05'), 'не-проверялось')
  eq(mapVerified('').keepLegacy, false) // терять нечего — legacy не плодим
  // «не-проверялось» само себя не ловит префиксом «не» и остаётся собой.
  eq(V('не-проверялось'), 'не-проверялось')
  eq(mapVerified('не-проверялось').keepLegacy, false)
  const T = (t, d = {}) => mapType(t, d)
  eq(T('knowledge-note'), 'concept')
  eq(T('security-tool-reference'), 'reference')
  eq(T('canonical-summary'), 'synthesis')
  eq(T('tool'), 'concept') // без repo/stars/license/risk карточкой инструмента не станет
  eq(T('tool', { repo: 'x' }), 'concept') // ОДНОГО поля мало: гейт всё равно потребует остальные три
  eq(T('tool', { repo: 'x', stars: 1, license: 'MIT' }), 'concept')
  eq(T('tool', { repo: 'x', stars: 1, license: 'MIT', risk: 'low' }), 'tool-card')
  eq(T('decision'), 'concept') // decision требует context+rejected — механически не ставим
  eq(T('reference'), 'reference')
  console.log('selftest ok')
  process.exit(0)
}

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    if (item.isDirectory() && !['.git', '.obsidian'].includes(item.name) && !item.name.startsWith('graphify-out')) out.push(...await walk(p))
    else if (item.isFile() && p.endsWith('.md')) out.push(p)
  }
  return out
}

// Копия предиката из mnemazine-vault-quality-gate.mjs — канон там. Скрипт обязан видеть РОВНО тот же набор
// файлов, что судит гейт: правь обе стороны вместе, иначе нормализатор чинит не то, что проверяется.
function isServicePath(rel) {
  return (
    rel.includes('/graphify-out/') ||
    rel.includes('/_legacy-index ') ||
    rel.includes('/_архив-дублей/') ||
    rel.includes('/Capabilities/_') ||
    /^99 Система\//.test(rel) ||
    /^00 System\//.test(rel) ||
    /(^|\/)_(Содержание|МАСТЕР-ИНДЕКС|ROUTING|ШАБЛОНЫ)\.md$/.test(rel) ||
    ['AGENTS.md', 'CLAUDE.md', '_ROUTING.md', 'Лог обработки.md'].includes(rel)
  )
}

const unquote = v => {
  const m = String(v).match(/^"(.*)"$/s) || String(v).match(/^'(.*)'$/s)
  return m ? m[1] : String(v)
}

/** Границы frontmatter + плоские скаляры/списки. Дубль ключа верхнего уровня = отказ (fail-closed). */
function readFrontmatter(text) {
  const lines = text.split('\n')
  if (!/^---\s*$/.test(lines[0] ?? '')) return { error: 'нет frontmatter' }
  let close = -1
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { close = i; break }
  if (close === -1) return { error: 'frontmatter не закрыт' }
  const data = {}
  const lineOf = {}
  let listKey = null
  for (let i = 1; i < close; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = line.match(/^([\w.-]+):(?:\s+(.*))?$/)
    if (kv) {
      const key = kv[1]
      if (Object.hasOwn(data, key)) return { error: `дубль ключа «${key}»` }
      const raw = (kv[2] ?? '').trim()
      lineOf[key] = i
      if (!raw) { data[key] = []; listKey = key }
      else if (/^\[.*\]$/.test(raw)) { data[key] = raw.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean); listKey = null }
      else { data[key] = unquote(raw); listKey = null }
      continue
    }
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey) { data[listKey].push(unquote(item[1].trim())); continue }
    if (/^\s/.test(line)) continue
    return { error: `непарсибельная строка ${i + 1}` }
  }
  return { data, lines, close, lineOf }
}

/** YAML-скаляр: кавычки только когда без них значение сменит смысл или сломает парсер. */
const yamlScalar = v => (/^[\wА-Яа-яЁё][\wА-Яа-яЁё .,()/@-]*$/.test(v) ? v : JSON.stringify(v))

/** Обход корпуса гейта — общий для приборов миграции (импортируется migration-check). */
export async function corpusFiles(vault) {
  return (await walk(vault)).filter(f => !isServicePath(path.relative(vault, f)))
}

export { readFrontmatter, yamlScalar }

// ── Исполнение: только при прямом вызове (страж isMain выше) ──
if (isMain) {
const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}
const VAULT = resolveVault({ cli: arg('vault') })
const APPLY = argv.includes('--apply') // fail-safe: по умолчанию сухой прогон, диск не трогается
const JSON_OUT = argv.includes('--json')

const files = (await walk(VAULT)).filter(f => !isServicePath(path.relative(VAULT, f)))
const report = { vault: VAULT, apply: APPLY, scanned: files.length, changed: 0, edits: { type: 0, verified: 0, source: 0, typeLegacy: 0, verifiedLegacy: 0 }, skipped: [] }

for (const file of files) {
  const rel = path.relative(VAULT, file)
  const text = await fs.readFile(file, 'utf8')
  const fm = readFrontmatter(text)
  if (fm.error) { report.skipped.push({ file: rel, reason: fm.error }); continue }

  const { data, lines, close, lineOf } = fm
  const insert = [] // строки, которых во frontmatter не было
  let touched = false

  const oldType = Array.isArray(data.type) ? '' : String(data.type ?? '')
  const newType = mapType(oldType, data)
  if (norm(oldType) !== norm(newType)) {
    // Оригинал сохраняем ДО перезаписи — иначе `security-tool-reference` исчезнет из ноты навсегда.
    if (oldType.trim() && !Object.hasOwn(data, 'type_legacy')) { insert.push(`type_legacy: ${yamlScalar(oldType.trim())}`); report.edits.typeLegacy++ }
    if (Object.hasOwn(lineOf, 'type')) lines[lineOf.type] = `type: ${newType}`
    else insert.push(`type: ${newType}`)
    report.edits.type++
    touched = true
  }

  const oldVerified = Array.isArray(data.verified) ? '' : String(data.verified ?? '')
  const mapped = mapVerified(oldVerified)
  if (oldVerified.trim() !== mapped.value) {
    if (mapped.keepLegacy && !Object.hasOwn(data, 'verified_legacy')) { insert.push(`verified_legacy: ${yamlScalar(oldVerified.trim())}`); report.edits.verifiedLegacy++ }
    if (Object.hasOwn(lineOf, 'verified')) lines[lineOf.verified] = `verified: ${mapped.value}`
    else insert.push(`verified: ${mapped.value}`)
    report.edits.verified++
    touched = true
  }

  // `source` НЕ выдумывается: берётся только первый непустой элемент уже существующего `sources`. Пусто —
  // значит провенанс правда неизвестен, и это работа конвейера, а не переименования.
  const hasSource = Array.isArray(data.source) ? data.source.some(s => String(s).trim()) : Boolean(String(data.source ?? '').trim())
  if (!hasSource) {
    const fromList = (Array.isArray(data.sources) ? data.sources : [data.sources]).map(s => String(s ?? '').trim()).find(Boolean)
    if (fromList) {
      if (Object.hasOwn(lineOf, 'source')) lines[lineOf.source] = `source: ${yamlScalar(fromList)}`
      else insert.push(`source: ${yamlScalar(fromList)}`)
      report.edits.source++
      touched = true
    }
  }

  if (!touched) continue
  report.changed++
  if (!APPLY) continue
  const out = [...lines.slice(0, close), ...insert, ...lines.slice(close)].join('\n')
  await fs.writeFile(file, out)
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${APPLY ? 'ПРИМЕНЕНО' : 'СУХОЙ ПРОГОН'} · vault ${report.vault}`)
  console.log(`просмотрено ${report.scanned} · изменено ${report.changed} · пропущено ${report.skipped.length}`)
  console.log(`  type ${report.edits.type} (сохранено type_legacy ${report.edits.typeLegacy})`)
  console.log(`  verified ${report.edits.verified} (сохранено verified_legacy ${report.edits.verifiedLegacy})`)
  console.log(`  source из sources ${report.edits.source}`)
  for (const s of report.skipped) console.log(`  ПРОПУСК ${s.file} — ${s.reason}`)
}
} // конец isMain
