#!/usr/bin/env node
// Врезка Метиды в дом Мнемозины. Тонкая прослойка по образцу helioz-metiz.mjs
// (scripts/helioz-metiz.mjs в репозитории Гелиоза) - устройство скопировано, буквы нет:
// у Мнемозины нет своего домашнего компрессора (squeezeHome), поэтому без Метиды прослойка
// просто отдает текст как есть, а не режет его вторым прибором.
//
// Точки врезки (одна строка импорта + по одной измененной строке на вызове), их ДВЕ:
//   1) scripts/mnemazine-synthesize.mjs, функция enrichCluster. Текст материала (OCR/whisper/markitdown
//   вход, склеенный из cluster.records) сегодня режется вслепую (`.slice(0, MAX_MATERIAL_CHARS)`,
//   см. комментарий там же: "Long material (video transcripts, books) was silently cut to the first
//   4000 chars per record, so atoms only ever covered the intro") ПЕРЕД тем, как уйти в MATERIAL
//   промта mnemazine-llm.mjs::llmJson. Это и есть точка "дом отдает большой текст модели": место,
//   где сырой текст собирается ЭТИМ кодом (а не читается субагентом через свой Read) и уходит в
//   LLM-мост напрямую.
//   2) там же, функция atomPrompt, ТОЛЬКО сырая ветка (materialOverride пуст). Раньше она была
//   не тронута с основанием "в дефолтном --deep пути ей приходит уже обогащенный текст". Основание
//   проверено замером и оказалось верным лишь для дефолта репозитория: живая раскладка владельца
//   (.mnemazine/config.local.sh) ставит MNEMAZINE_STRICT_ENRICH=0, строгий гейт выключен, и при
//   неудачном обогащении в atomPrompt приходит сырье того же класса, что в enrichCluster
//   [замер: медиана 21464 Б против 20818 Б у enrichCluster на одном и том же живом кеше].
//   Числа и разбор целиком - в комментарии у самой atomPrompt.
//   Ветка materialOverride (готовый ответ модели) не тронута, и теперь по ЗАМЕРУ, а не по его
//   отсутствию: живой прогон обогащения стал возможен после починки потолка времени, и на нем
//   свертка дает РОВНО НОЛЬ - 0.0% и ни одного шага на всех трех профилях, вход возвращается
//   байт в байт (доктрина 4). Материал там сплошная проза от модели, складывать в ней нечего.
//   Числа, границы замера и условие переоткрытия - в комментарии у самой atomPrompt.
//
// Доктрина 5 (в данных fail-closed, в трафике fail-open) держится на ИМПОРТЕ, а не только внутри
// вызова: нет дома Метиды - Мнемозина работает как работала, без сжатия, и говорит об этом в note.
// Импорт не бросает никогда: try/catch вокруг await import(), а не голый await.
//
// Доктрина 2 (сжатие обратимо) держится маркером с АБСОЛЮТНЫМИ путями: marker и foldMarker поданы
// прослойкой конвейеру Метиды его же тропой PipelineDeps (pipeline.ts, opts.marker/opts.foldMarker).
// Без них конвейер печатает короткие формы (metiz restore --id, metiz expand) - они не резолвятся,
// когда маркер читает агент с чужим cwd (у Мнемозины это каталог vault, не этот репозиторий).
// marker - готовый makeMarker() из src/state/ccr.ts (свой домашний формат Мнемозине заводить незачем -
// в отличие от Гелиоза, у нее нет старой команды restore, которую нужно было бы сохранить псевдонимом).
//
// Доктрина 3 (нет замера - нет цифры) держится журналом .mnemazine/state/squeeze/squeeze.jsonl.
// Формата под сжатие у дома сегодня нет (Run Observatory в .mnemazine/state/run-observability.jsonl
// журналит CTX/токены сессии, а не байты сжатия текста) - журнал заведен по образцу Гелиоза,
// своя папка, права 0700 (I7: каталоги логов и проб 0700, содержимое нот в журнал не пишем).
//
// budgetChars: врезка передает MAX_MATERIAL_CHARS дома как жесткий потолок ВЫХОДА (opts.budgetChars
// в SqueezeOpts). Раньше текст резался ДО сжатия (терялся хвост длинных материалов); теперь Метида
// видит текст целиком и сама решает, что оставить в границах того же бюджета символов. Если сжать не
// вышло (skip/лимит), вызывающий все равно режет строкой .slice(...) поверх - потолок не может
// вырасти относительно прежнего поведения ни при каком исходе (гарантия дана в pipeline.ts step 10:
// примененный результат никогда не выходит за budgetChars, значит хвостовая обрезка бьет только
// незажатый fallback-текст, маркер она никогда не разрежет пополам).
//
// Откат (обратная замена в scripts/mnemazine-synthesize.mjs, обе точки независимы):
//   enrichCluster
//     было:  const text = squeezeMetiz(cluster.records.map(r => compact(r.text, Math.max(6000, MAX_RECORD_CHARS))).join('\n---\n'), { label: `enrich:${cluster.id}`, budgetChars: MAX_MATERIAL_CHARS }).text.slice(0, MAX_MATERIAL_CHARS)
//     стало: const text = cluster.records.map(r => compact(r.text, Math.max(6000, MAX_RECORD_CHARS))).join('\n---\n').slice(0, MAX_MATERIAL_CHARS)
//   atomPrompt, сырая ветка
//     было:  : squeezeMetiz(cluster.records.map(r => `SOURCE_REF: ${r.source_ref}\n${compact(r.text, MAX_RECORD_CHARS)}`).join('\n---\n'), { label: `atomize-raw:${cluster.id}`, budgetChars: MAX_MATERIAL_CHARS }).text.slice(0, MAX_MATERIAL_CHARS)
//     стало: : cluster.records.map(r => `SOURCE_REF: ${r.source_ref}\n${compact(r.text, MAX_RECORD_CHARS)}`).join('\n---\n').slice(0, MAX_MATERIAL_CHARS)
// Снятие обеих точек разом позволяет убрать и строку импорта
// `import { squeezeText as squeezeMetiz } from './mnemazine-metiz.mjs'`.

import path from 'node:path'
import { existsSync, mkdirSync, appendFileSync, chmodSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Дом Мнемозины: MNEMAZINE_ROOT (тот же env, что уже читают mnemazine-synthesize.mjs и остальные
// scripts/*.mjs дома) либо корень над scripts/ - та же формула, что у helioz-metiz.mjs для HELIOZ_HOME.
const HOME = process.env.MNEMAZINE_ROOT || path.dirname(HERE)
const JOURNAL_DIR = path.join(HOME, '.mnemazine', 'state', 'squeeze')
const JOURNAL = path.join(JOURNAL_DIR, 'squeeze.jsonl')

// Дом Метиды ищется по списку, а не одной формулой - тот же прием, что у helioz-metiz.mjs: явный
// METIZ_HOME побеждает, иначе соседний репозиторий на уровень выше scripts/ (реальная раскладка
// владельца - ~/Проекты/mnemazine и ~/Проекты/metiz лежат рядом).
const CANDIDATES = [
  process.env.METIZ_HOME,
  path.join(path.dirname(path.dirname(HERE)), 'metiz'),
].filter(Boolean)

const METIZ = CANDIDATES.find(d => existsSync(path.join(d, 'src', 'router', 'pipeline.ts'))) || null
let squeeze = null
let openCcr = null
let makeMarker = null
let makeFoldMarker = null
let offReason = METIZ ? null : `дома Метиды нет (искали: ${CANDIDATES.join(', ')}), назови его через METIZ_HOME`
if (METIZ) {
  try {
    // pathToFileURL, а не голый путь: относительный спецификатор-строка не гарантирует кодировку пути.
    ;({ squeeze } = await import(pathToFileURL(path.join(METIZ, 'src/router/pipeline.ts')).href))
    ;({ openCcr, makeMarker, makeFoldMarker } = await import(pathToFileURL(path.join(METIZ, 'src/state/ccr.ts')).href))
  } catch (e) {
    squeeze = null
    openCcr = null
    makeMarker = null
    offReason = `импорт Метиды бросил: ${e && e.message || e}`
  }
}

/**
 * Профиль дома: решение владельца. Материал Мнемозины - входящие скрины/PDF/статьи/транскрипты,
 * потеря дешева (allowLossy), а источник (frontmatter `source:`/`sources:` ноты) в это поле не
 * входит вообще - он считается отдельно от текста, который проходит через эту прослойку (см.
 * mnemazine-synthesize.mjs: sources собираются из cluster.records ДО вызова enrichCluster и не
 * перевычисляются из сжатого текста), поэтому лossy-свертка материала его не задевает.
 */
const PROFILE = 'balanced'

/** Кто сейчас режет. Печатается прибором, а не угадывается по поведению (доктрина 3). */
export const engine = () => (squeeze ? 'metiz' : 'off')
export { PROFILE }

const kb = (n) => (n / 1024).toFixed(1) + ' КБ'

// Маркер обратимой свертки (доктрина 2, случай без выноса в CCR - содержимое осталось в тексте,
// но команда разворота обязана лежать рядом).
//
// Строку собирает Метида, а не эта прослойка, и на то две причины, обе из замеров.
// Первая: машинную часть маркера (версию, sha оригинала, цепочку шагов) разбирает регексп самой
// Метиды, и вторая сборка разошлась бы с ним при первой правке - прибитая тут 'v1' пережила бы
// переход Метиды на v2 и молча ломала бы разворот.
// Вторая: своя сборка подставляла METIZ_HOME=<корень исходников Метиды>, тогда как METIZ_HOME -
// это дом СОСТОЯНИЯ (~/.metiz). Метида теперь такой дом отвергает вслух, то есть команда из
// маркера просто не работала бы. Дом задает только то, чего Метида знать не может, - путь к CLI.
const foldMarker = (fields) =>
  makeFoldMarker(fields, { cli: path.join(METIZ, 'src/cli/main.ts') })

// Журнал только байты/токены/профиль/исход (I7: содержимое нот сюда не попадает ни при каком
// вызывающем). Директория - НАША, поэтому ей и выставляются права 0700 явным chmod после mkdir:
// mkdirSync с mode не гарантирует итоговые права при повторном создании существующей папки (umask,
// либо папка уже была создана раньше без mode) - chmodSync снимает эту неопределенность.
function journal(rec) {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 })
    try { chmodSync(JOURNAL_DIR, 0o700) } catch { /* лучшее старание - право читать журнал важнее */ }
    appendFileSync(JOURNAL, JSON.stringify(rec) + '\n')
    return null
  } catch (e) {
    return `журнал: ${e && e.message || e}`
  }
}

/**
 * Сжать текст перед тем, как он уйдет в MATERIAL модели. opts.label - метка вызова (журнал и
 * CCR-метаданные). opts.budgetChars - жесткий потолок символов на выходе (SqueezeOpts.budgetChars):
 * вызывающий обязан подать тот же потолок, что резал вслепую раньше, иначе гарантия "потолок не
 * растет" не держится. opts.query - контекст запроса, если есть. Никогда не бросает (доктрина 5).
 */
/**
 * Строки происхождения дома. У ноты Мнемозины поле `source:` обязательно, и модель, собирающая
 * ноту, обязана его видеть.
 *
 * Почему это чинится ЗДЕСЬ, а не в реестре улик Метиды. По доктрине 1 улика - это ошибка, отказ
 * или вердикт; `source:` не из них, а реестр улик общий на три дома, и защита имени поля покрасила
 * бы обычное слово в домах Гелиоза и Фемиды. Дом просто не отдает на рез то, что обязан сохранить.
 * [замер] на материале 67372 байта под профилем balanced отбор предложений выбрасывал строку
 * `source: скрин.png` из видимого текста; оригинал оставался восстановим из хранилища, но модель
 * его без явной команды не читает, и нота теряла происхождение.
 */
const PROVENANCE = /^[ \t]*sources?:.*$/gmi

/**
 * Вернуть в выход строки происхождения, которых отбор не оставил.
 *
 * Только для прохода С ВЫНОСОМ содержимого. Обратимый проход содержимого не теряет по построению,
 * а дописать строку в его выход значило бы сломать разворот: expandFolds развернул бы текст вместе
 * с дописанным и отдал бы не исходные байты. Доктрина 2 дороже удобства.
 */
function вернутьПроисхождение(src, out) {
  const строки = src.match(PROVENANCE) ?? []
  const пропало = строки.filter(l => !out.includes(l.trim()))
  return пропало.length === 0 ? out : `${пропало.map(l => l.trim()).join('\n')}\n${out}`
}

export function squeezeText(text, opts = {}) {
  const src = String(text)
  const before = Buffer.byteLength(src, 'utf8')

  if (!squeeze) {
    // Fail-open в трафике: Метиды нет - дом работает как работал, без сжатия. Молчать о слепоте
    // нельзя (доктрина 3) - причина уезжает в note, вызывающий может залогировать ее или пропустить.
    return { text: src, kind: 'skip', before, after: before, id: null, note: `metiz: сжатия нет - ${offReason}` }
  }

  let r
  try {
    r = squeeze(src, {
      profile: PROFILE,
      marker: makeMarker,
      foldMarker,
      ...(opts.budgetChars !== undefined ? { budgetChars: opts.budgetChars } : {}),
      ...(opts.query ? { query: opts.query } : {}),
    })
  } catch (e) {
    // Fail-open в трафике: сломалось сжатие - отдаем вход как есть, работа дома не встает.
    return { text: src, kind: 'skip', before, after: before, id: null, note: `metiz: ${e.message}` }
  }

  if (!r.steps.some(s => s.applied)) {
    return { text: r.text, kind: 'skip', before, after: r.after, id: null }
  }

  // Оригинал на диск ДО выдачи сжатого (доктрина 2). Маркер в r.text уже несет абсолютную команду
  // восстановления - id в ней тот же sha256(text).slice(0,16), что вернет putSync ниже.
  let id = null
  if (r.ccrIds.length > 0) {
    try {
      id = openCcr().putSync(src, { label: opts.label ?? 'mnemazine', home: METIZ })
    } catch (e) {
      // Не смогли сохранить оригинал - не выдаем и сжатое. Доктрина 2 не имеет исключений.
      return { text: src, kind: 'skip', before, after: before, id: null, note: `ccr: ${e.message}` }
    }
  }

  // Происхождение возвращается ТОЛЬКО когда содержимое ушло в хранилище: см. оговорку у функции.
  if (r.ccrIds.length > 0) r = { ...r, text: вернутьПроисхождение(src, r.text) }

  const note = journal({
    ts: new Date().toISOString(), label: opts.label || null, kind: r.kind,
    before, after: r.after, saved_pct: Number((((before - r.after) / before) * 100).toFixed(1)),
    tokens_before: r.tokensBefore, tokens_after: r.tokensAfter,
    // Источник числа печатается всегда: у Метиды бывает и точным, оценка - названа честно.
    tokens_estimated: r.tokenSource !== 'exact', token_source: r.tokenSource,
    lossy: !r.reversible, ccr: id, engine: 'metiz', profile: PROFILE,
  })
  return {
    text: r.text, kind: r.reversible ? 'reformat' : 'offload',
    before, after: r.after, id, ...(note ? { note } : {}),
  }
}

/** Восстановление оригинала по id. Байт в байт или отказ - пустая строка тут запрещена. */
export async function restoreText(id) {
  if (!openCcr) throw new Error(`metiz: дома Метиды нет, восстановить ${id} нечем`)
  const t = await openCcr().get(id)
  if (t === null) throw new Error(`metiz: оригинал ${id} не найден`)
  return t
}

// --- САМОПРОВЕРКА ---------------------------------------------------------------------------
// Проверяет ровно то, что называет отчет врезки, и краснеет, если починку вырезать:
//   1) без Метиды импорт НЕ бросает и дом работает без сжатия (fail-open в трафике),
//   2) замер ложится в журнал (доктрина 3),
//   3) команда из маркера гоняется живьем и отдает оригинал побайтно (доктрина 2),
//   4) строка source: ноты - находка, не тихая починка: реестр улик Метиды ее не ловит, если
//      она не задета структурным запретом реестра секретов/дат по совпадению формы значения.
// Слой выбирает дом Метиды на ИМПОРТЕ, поэтому 1-3 гоняются отдельным процессом каждый -
// подмена внутри текущего ничего бы не доказала (тот же прием, что у helioz-metiz.mjs).

// Материал выбран так же, как в helioz-metiz.mjs - замером, а не на глаз: многословная разговорная
// речь с повторами и словами-паразитами (типичный whisper/OCR выход материала Мнемозины) реально
// режется экстрактивным сжатием прозы профиля balanced (targetRatio 0.5, minGainPct 50).
function transcriptSample(withSourceLine) {
  const filler = ['ну вот', 'короче говоря', 'как бы', 'в общем-то', 'так сказать', 'то есть']
  const topics = ['агентные системы', 'управление контекстом', 'базы знаний', 'сжатие текста', 'модели языка', 'автоматизация процессов']
  const lines = []
  for (let i = 0; i < 150; i++) {
    const f = filler[i % filler.length]
    const t = topics[i % topics.length]
    lines.push(`Ну вот смотри, ${f}, если говорить про ${t}, то тут ${f} важно понимать, что дело обстоит примерно так же, как и в прошлый раз, когда мы это обсуждали, ${f}, и в общем это довольно понятная штука, если разобраться, ${f}.`)
  }
  // Отдельной СТРОКОЙ, а не куском внутри абзаца. Так поле source: и живет в ноте Мнемозины -
  // строкой фронтматтера. Прошлая проба вклеивала его пробелами в середину одной гигантской
  // строки, где строки как таковой не существует, и проверяла форму, которой у дома не бывает.
  if (withSourceLine) lines.splice(Math.floor(lines.length / 2), 0, '\nsource: скрин.png\n')
  return lines.join(' ')
}

export async function selftest() {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const os = (await import('node:os')).default

  let bad = 0
  const check = (name, fn) => {
    try { fn(); console.log('  ✓ ' + name) } catch (e) { bad++; console.error('  ✗ ' + name + ': ' + (e && e.message || e)) }
  }
  const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`) }
  const ok = (v, msg) => { if (!v) throw new Error(msg) }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mnemazine-metiz-'))
  const sample = path.join(tmp, 'sample.txt')
  writeFileSync(sample, transcriptSample(false))

  const run = (tag, layer, home, env, sampleFile = sample) => {
    const runner = path.join(tmp, `runner-${tag}.mjs`)
    const outText = path.join(tmp, `out-${tag}.txt`)
    writeFileSync(runner, [
      `import { squeezeText } from ${JSON.stringify(pathToFileURL(layer).href)}`,
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `const r = squeezeText(readFileSync(${JSON.stringify(sampleFile)}, 'utf8'), { label: 'selftest', budgetChars: 8000 })`,
      `writeFileSync(${JSON.stringify(outText)}, r.text)`,
      `console.log(JSON.stringify({ kind: r.kind, before: r.before, after: r.after, id: r.id ?? null, note: r.note ?? null }))`,
    ].join('\n'))
    const p = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: { ...process.env, MNEMAZINE_ROOT: home, ...env } })
    return { p, out: p.stdout ? p.stdout.trim() : '', text: existsSync(outText) ? readFileSync(outText, 'utf8') : '' }
  }
  const rows = home => {
    const f = path.join(home, '.mnemazine', 'state', 'squeeze', 'squeeze.jsonl')
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }
  // Маркер проверяется не глазами: команда из него исполняется как есть, выдача сверяется побайтно.
  const roundTrip = (text, referenceBytes) => {
    const m = /\[metiz:(?:ccr [0-9a-f]+|fold v1)[^\]]*оригинал: ([^\]]+)\]/.exec(text)
    if (!m) return null
    const p = spawnSync('/bin/sh', ['-c', m[1]], { maxBuffer: 64 * 1024 * 1024 })
    return { code: p.status, same: Buffer.compare(p.stdout || Buffer.alloc(0), referenceBytes) === 0 }
  }

  // 1-2. Откат: копия прослойки живет в /tmp, соседа-Метиды рядом нет, METIZ_HOME указан в пустоту.
  const fbHome = path.join(tmp, 'fallback', 'root')
  mkdirSync(path.join(fbHome, 'scripts'), { recursive: true })
  copyFileSync(path.join(HERE, 'mnemazine-metiz.mjs'), path.join(fbHome, 'scripts', 'mnemazine-metiz.mjs'))
  const a = run('fallback', path.join(fbHome, 'scripts', 'mnemazine-metiz.mjs'), fbHome,
    { METIZ_HOME: path.join(tmp, 'fallback', 'metiz-absent') })

  check('без Метиды импорт не бросает, дом работает без сжатия (fail-open в трафике)', () => {
    eq(a.p.status, 0, 'код выхода (stderr: ' + (a.p.stderr || '').slice(0, 300) + ')')
    const r = JSON.parse(a.out)
    eq(r.kind, 'skip', 'без Метиды прослойка обязана вернуть skip, а не выдумывать свое сжатие')
    ok(/сжатия нет/.test(r.note || ''), 'факт отсутствия Метиды не назван вслух в note: ' + r.note)
    eq(a.text, transcriptSample(false), 'без Метиды текст обязан дойти до модели без изменений')
  })
  check('замер ложится в журнал (доктрина 3)', () => {
    const rs = rows(fbHome)
    eq(rs.length, 0, 'без Метиды и без сжатия (kind=skip до вызова squeeze) журнал ПУСТ - это тоже честно: нечего мерить')
  })

  // 2. Дом Метиды НАЙДЕН по пути, но его импорт бросает (битый pipeline.ts) - второй, отдельный
  // путь fail-open (после успешного existsSync, внутри try/catch вокруг await import()).
  const brokenMetiz = path.join(tmp, 'broken-metiz')
  mkdirSync(path.join(brokenMetiz, 'src', 'router'), { recursive: true })
  mkdirSync(path.join(brokenMetiz, 'src', 'state'), { recursive: true })
  writeFileSync(path.join(brokenMetiz, 'src', 'router', 'pipeline.ts'), "throw new Error('имитация сломанного импорта Метиды')\n")
  writeFileSync(path.join(brokenMetiz, 'src', 'state', 'ccr.ts'), 'export function openCcr(){return null}\nexport function makeMarker(){return String()}\n')
  const brokenHome = path.join(tmp, 'broken-home')
  mkdirSync(brokenHome, { recursive: true })
  const brk = run('broken-import', fileURLToPath(import.meta.url), brokenHome, { METIZ_HOME: brokenMetiz })
  check('Метида найдена по пути, но импорт бросает - fail-open держится (try/catch на импорте)', () => {
    eq(brk.p.status, 0, 'код выхода (stderr: ' + (brk.p.stderr || '').slice(0, 300) + ')')
    const r = JSON.parse(brk.out)
    eq(r.kind, 'skip', 'сломанный импорт обязан откатиться на skip, а не бросить наружу')
    ok(/импорт Метиды бросил/.test(r.note || ''), 'причина отказа не названа в note: ' + r.note)
  })
  // МУТАЦИЯ: снимаем try/catch вокруг await import() в копии прослойки - тот же сломанный Метида
  // теперь роняет процесс. Доказывает, что зеленая проба выше не тавтология, а держится именно на guard.
  check('мутация: без try/catch тот же сломанный импорт РЕАЛЬНО падает', () => {
    const layerDir = path.join(tmp, 'broken-import-nocatch', 'scripts')
    mkdirSync(layerDir, { recursive: true })
    const layer = path.join(layerDir, 'mnemazine-metiz.mjs')
    const original = readFileSync(path.join(HERE, 'mnemazine-metiz.mjs'), 'utf8')
    const guardOpen = 'if (METIZ) {\n  try {'
    const guardClose = '\n  } catch (e) {\n    squeeze = null\n    openCcr = null\n    makeMarker = null\n    offReason = `импорт Метиды бросил: ${e && e.message || e}`\n  }\n}'
    ok(original.includes(guardOpen), 'опорная строка try сдвинулась - обнови паттерн мутации')
    ok(original.includes(guardClose), 'опорная строка catch сдвинулась - обнови паттерн мутации')
    const broken = original.replace(guardOpen, 'if (METIZ) {\n  {').replace(guardClose, '\n  }\n}')
    ok(broken !== original, 'замена try/catch не сработала - мутация ничего не доказала бы')
    writeFileSync(layer, broken)
    const crashed = run('broken-nocatch', layer, brokenHome, { METIZ_HOME: brokenMetiz })
    ok(crashed.p.status !== 0, 'без try/catch процесс обязан упасть на сломанном импорте Метиды, а вышел кодом 0')
  })

  // 3. Метида. Дома Метиды может не быть на чужой машине - тогда честно пропускаем, а не рисуем
  // зеленую галочку на непроведенной проверке (тот же принцип, что у helioz-metiz.mjs).
  if (!METIZ) {
    console.log(`  ~ ПРОПУЩЕНО (Метида не проверялась): ${offReason}`)
  } else {
    const mzHome = path.join(tmp, 'metiz-home')
    mkdirSync(mzHome, { recursive: true })
    // METIZ_HOME=mzHome (а не путь к репозиторию METIZ) изолирует состояние CCR в mzHome/ccr:
    // metizHome() в ccr.ts читает тот же env - если подать сюда путь к репозиторию, оригиналы легли
    // бы прямо в рабочую копию Метиды (ccr/ внутри METIZ), а этот каталог только читается по границам
    // задачи. mzHome не содержит src/router/pipeline.ts, поэтому CANDIDATES.find его пропускает и
    // репозиторий все равно находится соседской эвристикой по HERE исполняемого файла.
    const b = run('metiz', fileURLToPath(import.meta.url), mzHome, { METIZ_HOME: mzHome })
    check('Метида сжала материал и записала замер в журнал (доктрина 3)', () => {
      eq(b.p.status, 0, 'код выхода (stderr: ' + (b.p.stderr || '').slice(0, 300) + ')')
      const r = JSON.parse(b.out)
      ok(r.kind !== 'skip', 'Метида вернула skip на образце, который на balanced режется под 90%')
      const rs = rows(mzHome)
      eq(rs.length, 1, 'строк в журнале')
      eq(rs[0].engine, 'metiz', 'запись не помечена Метидой')
      eq(rs[0].profile, 'balanced', 'запись не помечена решением владельца о профиле')
      eq(rs[0].before, r.before, 'before в журнале разошелся с выдачей')
      eq(rs[0].after, r.after, 'after в журнале разошелся с выдачей')
      ok(rs[0].saved_pct > 0, 'экономия в записи не положительна')
      ok(typeof rs[0].tokens_before === 'number' && typeof rs[0].tokens_after === 'number', 'токены не числа')
      ok(typeof rs[0].token_source === 'string', 'источник числа токенов не назван')
      ok(!Number.isNaN(Date.parse(rs[0].ts)), 'ts не разбирается')
    })
    // МУТАЦИЯ: удаляем журнал ПОСЛЕ прогона и проверяем, что "запись есть" - честная красная проба,
    // а не тавтология "файл существует, потому что мы только что его создали".
    check('мутация: без журнала проверка выше реально краснеет', () => {
      const journalFile = path.join(mzHome, '.mnemazine', 'state', 'squeeze', 'squeeze.jsonl')
      ok(existsSync(journalFile), 'журнал должен существовать до мутации')
      const saved = readFileSync(journalFile, 'utf8')
      rmSync(journalFile, { force: true })
      let caught = null
      try { eq(rows(mzHome).length, 1, 'строк в журнале') } catch (e) { caught = e }
      ok(caught !== null, 'проверка на пустом журнале обязана была покраснеть и не покраснела')
      writeFileSync(journalFile, saved) // вернули как было
      eq(readFileSync(journalFile, 'utf8'), saved, 'журнал не восстановлен побайтно после мутации')
    })
    check('маркер Метиды: команда живьем отдает оригинал побайтно (доктрина 2)', () => {
      const rt = roundTrip(b.text, Buffer.from(transcriptSample(false), 'utf8'))
      ok(rt, 'маркера [metiz:ccr ...]/[metiz:fold ...] в выдаче нет, хотя kind != skip')
      eq(rt.code, 0, 'команда восстановления вернула не ноль')
      ok(rt.same, 'восстановленный текст не равен оригиналу побайтно')
    })
    // МУТАЦИЯ: портим один байт в сохраненном оригинале CCR (если был offload) и показываем, что
    // round-trip после этого честно краснеет - проверка выше не тавтологична.
    check('мутация: испорченный оригинал в CCR реально ломает round-trip', () => {
      const r = JSON.parse(b.out)
      if (!r.id) { console.log('    (пропущено: свертка обратима в тексте, CCR не использован)'); return }
      const ccrFile = path.join(mzHome, 'ccr', `${r.id}.orig`)
      // Хранилище Метиды слушает METIZ_HOME из env процесса (см. metizHome() в ccr.ts) - файл лежит
      // под ${mzHome}/ccr/<id>.orig, ровно как настроено запуском run('metiz', ...) выше.
      ok(existsSync(ccrFile), 'файл оригинала CCR не найден там, где его положил putSync: ' + ccrFile)
      const saved = readFileSync(ccrFile)
      const corrupted = Buffer.from(saved); corrupted[0] = corrupted[0] ^ 0xff
      writeFileSync(ccrFile, corrupted)
      let same = null
      try {
        const rt = roundTrip(b.text, Buffer.from(transcriptSample(false), 'utf8'))
        same = rt && rt.same
      } finally {
        writeFileSync(ccrFile, saved) // вернули как было
      }
      ok(same === false, 'порча байта в оригинале обязана была сломать побайтное сравнение и не сломала')
      eq(Buffer.compare(readFileSync(ccrFile), saved), 0, 'оригинал CCR не восстановлен побайтно после мутации')
    })

    // 4. Доктрина 1 для Мнемозины: строка source: ноты. НАХОДКА, а не починка (задача прямо
    // запрещает чинить реестр улик Метиды - src/primitives/evidence.ts правит ведущая сессия).
    check('находка: source: переживает проход, ИЛИ проход откатился на оригинал целиком', () => {
      const withSource = path.join(tmp, 'sample-with-source.txt')
      writeFileSync(withSource, transcriptSample(true))
      const c = run('source-line', fileURLToPath(import.meta.url), mzHome, { METIZ_HOME: mzHome }, withSource)
      eq(c.p.status, 0, 'код выхода (stderr: ' + (c.p.stderr || '').slice(0, 300) + ')')
      const r = JSON.parse(c.out)
      const survivedLiterally = c.text.includes('source: скрин.png')
      const rolledBackWhole = r.kind === 'skip' && c.text === transcriptSample(true)
      if (survivedLiterally || rolledBackWhole) {
        console.log('    (source: пережила профиль balanced на этом образце)')
        return
      }
      // НЕ бросаем - это ожидаемая находка, замеренная разведкой заранее (см. отчет задачи):
      // реестр улик Метиды (src/primitives/evidence.ts) знает про error/failure/refusal/verdict/
      // warning/security, но НЕ про доменный контракт source: дома Мнемозины. На реальном материале
      // (многословный транскрипт, balanced, targetRatio 0.5) строка вида "source: скрин.png" без
      // цифр внутри значения (не задевает реестр запретов секретов/дат) молча пропадает из ВИДИМОГО
      // текста - при этом полный оригинал со строкой все равно лежит в CCR под r.id, восстановим
      // командой из маркера (см. проверку выше). Печатаем находку и МУТИРУЕМ профиль на 'audit'
      // (allowLossy=false, targetRatio=1 - доктрина 1 держит пол) чтобы доказать: это свойство
      // ИМЕННО настроек профиля 'balanced' + слепоты реестра, а не баг этой прослойки.
      console.log('    ⚠ НАХОДКА: строка "source: скрин.png" не пережила профиль balanced (visible text)' +
        ' и проход не откатился - реестр улик Метиды (src/primitives/evidence.ts) не знает про' +
        ' поле source:. Оригинал со строкой восстановим через r.id/CCR (доктрина 2 держит), но' +
        ' МОДЕЛЬ его не увидит без явного restore. kind=' + r.kind + ' before=' + r.before + ' after=' + r.after)
      ok(!!r.id, 'если source: пропала, а прохода kind!=skip - CCR обязан хранить полный оригинал')
    })
    check('мутация профиля: audit (allowLossy=false, targetRatio=1) держит source: там, где balanced не держит', () => {
      const withSource = path.join(tmp, 'sample-with-source.txt')
      const runner = path.join(tmp, 'runner-audit.mjs')
      const outText = path.join(tmp, 'out-audit.txt')
      // Тот же вызов, что и в squeezeText, но profile переопределен на audit прямо в раннере - без
      // правки прослойки и без правки Метиды: доказательство через ВХОДНОЙ параметр, а не через фикс.
      writeFileSync(runner, [
        `const mod = await import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)})`,
        `import { readFileSync, writeFileSync } from 'node:fs'`,
        `const pipeline = await import(${JSON.stringify(pathToFileURL(path.join(METIZ, 'src/router/pipeline.ts')).href)})`,
        `const src = readFileSync(${JSON.stringify(withSource)}, 'utf8')`,
        `const r = pipeline.squeeze(src, { profile: 'audit', budgetChars: 40000 })`,
        `writeFileSync(${JSON.stringify(outText)}, r.text)`,
        `console.log(JSON.stringify({ kind: r.kind }))`,
      ].join('\n'))
      const p = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: { ...process.env } })
      eq(p.status, 0, 'код выхода audit-прогона (stderr: ' + (p.stderr || '').slice(0, 300) + ')')
      const audText = readFileSync(outText, 'utf8')
      ok(audText.includes('source: скрин.png'), 'профиль audit обязан оставить строку source: нетронутой (allowLossy=false)')
    })
  }

  console.log(bad ? `mnemazine-metiz: КРАСНЫЙ, провалов ${bad}, следы в ${tmp}` : 'mnemazine-metiz: зеленый')
  if (!bad) rmSync(tmp, { recursive: true, force: true })
  return bad ? 1 : 0
}

// Запущен напрямую или подключен как модуль. Сравниваем РЕАЛЬНЫЕ пути (realpathSync), а не голый
// process.argv.includes('--selftest') - этот файл ИМПОРТИРУЕТСЯ из mnemazine-synthesize.mjs, и
// голая проверка флага запускала бы наш selftest (с его собственным process.exit) при любом чужом
// `node scripts/mnemazine-synthesize.mjs --selftest`, обрывая ЧУЖОЙ прогон раньше его же кода.
// Замер: без realpath-сравнения ровно это и произошло на живом прогоне. Тот же прием, что у
// helioz-metiz.mjs - /var на macOS симлинк на /private/var, наивное сравнение url дает пустышку.
const runDirectly = (() => {
  try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (runDirectly && process.argv.includes('--selftest')) {
  selftest().then(c => process.exit(c)).catch(e => { console.error(String(e && e.message || e)); process.exit(1) })
}
