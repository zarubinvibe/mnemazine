import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPEC_TYPES = new Set(['concept', 'tool-card', 'decision', 'synthesis', 'agent-research', 'reference'])
export const SPEC_VERIFIED = ['подтвержден', 'источник-не-найден', 'непроверяемо-методом', 'облако-недоступно', 'проверено-практикой', 'не-проверялось']
export const SPEC_SUBJECTS = new Set(['self', 'world', 'mixed'])
export const MIN_CYR_SHARE = 0.30

// data_class enum (П24) — единая правда о классах живет в config/data-classes.json;
// здесь она только ЧИТАЕТСЯ, не переопределяется (правило 8: одна правда на две
// границы). null, если таксономия недоступна → поле не энфорсится (как type до П05).
export const SPEC_DATA_CLASSES = (() => {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'data-classes.json')
    return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).classes))
  } catch { return null }
})()

export const TYPE_REQUIRED_FIELDS = {
  'tool-card': ['repo', 'stars', 'license', 'risk'],
  'agent-research': ['project', 'agent', 'claim_status']
}

// Буква с точками пишется код-пойнтом: дом-стиль «без нее» уже съел литерал, и замена стала «е → е» -
// нормализация enum была пустой, «подтвержден» и «подтвержден с точками» сходились только благодаря регистру
// (найдено при ревью схемы планов Гелиоза 2026-09-02, вопрос В14).
export function normSpecValue(value) {
  return String(value ?? '').replace(/\u0451/g, '\u0435').replace(/\u0401/g, '\u0415').toLowerCase()
}

export const SPEC_VERIFIED_NORM = new Set(SPEC_VERIFIED.map(v => normSpecValue(v)))

// Русский склоняет имя проекта («для Мнемозины», «в Фемиде»), а слаг берётся из
// заголовка «99 Система/_ПРОЕКТЫ.md» в именительном («Мнемозина») — подстрочный
// поиск их не связывал, и живой блок «Как это поможет мне» проваливал гейт из-за
// падежа, а не из-за отсутствия проекта. Отрезаем ОДНО падежное окончание с конца.
// Порядок важен: длинные окончания идут первыми, иначе «-ами» съедается как «-и».
const RU_ENDINGS = ['ами', 'ями', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ой', 'ей', 'ою', 'ею', 'ом', 'ем', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'ь']
const STEM_MIN = 5 // короче — уже не имя проекта, а обычное слово

export function ruStem(word) {
  for (const end of RU_ENDINGS) {
    if (word.endsWith(end) && word.length - end.length >= STEM_MIN) return word.slice(0, -end.length)
  }
  return word
}

const isCyrillicWord = s => /^[а-яё]+$/.test(s)

// Слаги проектов — только грепом ## заголовков _ПРОЕКТЫ.md, не хардкод.
// Однословные имена покрыты полным заголовком; из многословных дополнительно
// берутся «кавычечные» имена и латинские токены ≥5 символов — кириллические
// токены многословного заголовка («Просто», «партнеры») дают ложные совпадения
// с обычной прозой, поэтому исключены.
// Однословное кириллическое имя дополнительно кладётся основой (ruStem), чтобы
// «Мнемозины» и «Фемиде» засчитывались наравне с именительным падежом.
export function projectSlugs(text) {
  const slugs = new Set()
  const add = value => {
    const v = normSpecValue(value)
    if (!v) return
    slugs.add(v)
    if (isCyrillicWord(v)) slugs.add(ruStem(v))
  }
  for (const [, h] of String(text || '').matchAll(/^##\s+(.+?)\s*$/gm)) {
    add(h)
    for (const [, q] of h.matchAll(/«([^»]+)»/g)) add(q)
    for (const t of h.split(/\s+/)) {
      const tok = t.replace(/[«»()"'.,:;]/g, '')
      if (tok.length >= 5 && /[A-Za-z]/.test(tok)) slugs.add(normSpecValue(tok))
    }
  }
  return [...slugs]
}

// Единая правда о составе тела ноты (docs/NOTE-SPEC.md:63-83). Приборы, которым
// нужен список блоков, читают ЭТОТ массив, а не заводят свою копию (план П13, шаг 7).
// mandatory — блок обязателен всегда (NOTE-SPEC.md:82: 1, 7, 8); untouchable — зона,
// которую очеловечивание не трогает, гейт сохранности сверяет ее побайтово.
export const SPEC_BODY_HEADINGS = [
  { n: 1, title: 'Короткий ответ', re: /^##\s+Короткий ответ\s*$/m, mandatory: true },
  { n: 2, title: 'Механика', re: /^##\s+Механика\s*$/m },
  { n: 3, title: 'Применение', re: /^##\s+Применение\s*$/m },
  { n: 4, title: 'Примеры и контрпримеры', re: /^##\s+Примеры и контрпримеры\s*$/m },
  { n: 5, title: 'Ошибки и границы', re: /^##\s+Ошибки и границы\s*$/m },
  { n: 6, title: 'Опыт практиков', re: /^##\s+Опыт практиков\s*$/m },
  { n: 7, title: 'Как это поможет мне', re: /^##\s+(?:🎯\s*)?Как это поможет мне\s*$/m, mandatory: true },
  { n: 8, title: 'Достоверность', re: /^##\s+Достоверность\s*$/m, mandatory: true, untouchable: true },
  { n: 9, title: 'Связанные темы', re: /^##\s+Связанные темы\s*$/m },
  { n: 10, title: 'Следующий ход', re: /^##\s+Следующий ход\s*$/m }
]

export const SPEC_UNTOUCHABLE_HEADINGS = SPEC_BODY_HEADINGS.filter(h => h.untouchable)

function noteSectionAfter(text, label) {
  const start = String(text || '').indexOf(label)
  if (start === -1) return ''
  const tail = text.slice(start + label.length)
  const next = tail.search(/\n##\s+/)
  return next === -1 ? tail : tail.slice(0, next)
}

function noteSectionsAfter(text, labels) {
  return labels.map(label => noteSectionAfter(text, label)).filter(Boolean).join('\n')
}

export function strictKnowledgeReady(text) {
  const facts = noteSectionsAfter(text, [
    'External facts added before atomization:',
    'Факты, добавленные до атомизации:'
  ])
  const sources = noteSectionsAfter(text, [
    'Public/source expansion:',
    'Публичные источники:'
  ])
  const factCount = facts
    .split('\n')
    .filter(line => /^\s*-\s+\S/.test(line) && !/No external enrichment facts recorded|Внешние факты не записаны/i.test(line))
    .length
  // `verified:` has one truth — the NOTE-SPEC enum. Notes written before that
  // rule still carry the legacy boolean, so both spellings of "confirmed" pass
  // and older batches keep the coverage they earned.
  return /^status:\s*"final"\s*$/m.test(text) &&
    /^verified:\s*(?:true|"?подтвержден"?)\s*$/m.test(text) &&
    /^verification_status:\s*"verified"\s*$/m.test(text) &&
    /^enrichment:\s*"external-research"\s*$/m.test(text) &&
    factCount >= 2 &&
    /https?:\/\//i.test(sources)
}
