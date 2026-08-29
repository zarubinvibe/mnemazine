#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const REPORT = arg('report', '')
const REPORTS = path.resolve(arg('reports', process.env.MNEMAZINE_REPORTS || path.join(ROOT, 'reports')))
// fail-closed: «no reports found» больше не зеленый. Ноль отчетов = exit 2,
// если не передан явный --allow-empty.
const ALLOW_EMPTY = argv.includes('--allow-empty')

const rawMarkers = [
  /raw\s+ocr/i,
  /сырой\s+ocr(?!\s+исключ[её]н)/i,
  /ocr\s+без\s+синтеза/i,
  /распознанный\s+текст\s+без\s+обработки/i,
  /Video keyframe OCR/i,
  /Video transcript from local Whisper/i,
  /No extractable text/i,
  /intake-draft/i,
  /draft-local/i,
  /\btemp_image[_-]/i,
  /\bIMG_\d+/,
  /\.(WEBP|PNG|JPE?G|HEIC|TIFF|MOV|MP4)\b/i,
  /\b[\wА-Яа-яЕе ._-]+\.md\b/i
]

const requiredSignals = [
  { name: 'synthesis', re: /Синтез|Synthesis|Вывод/i },
  { name: 'source-expansion', re: /Расширил источниками|External sources|Дополнено источниками|Источники/i },
  { name: 'application', re: /Где применить|Применение|Apply/i },
  { name: 'risk-or-verification', re: /Проверка|Риск|Verification|Risk/i },
  { name: 'next-action', re: /Следующее действие|Next action/i }
]

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

async function listReports() {
  if (REPORT) return [path.resolve(REPORT)]
  const files = await fs.readdir(REPORTS, { withFileTypes: true }).catch(() => [])
  return files
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => path.join(REPORTS, entry.name))
}

async function checkReport(file) {
  const html = await fs.readFile(file, 'utf8')
  const text = stripHtml(html)
  const failures = []
  const rawHits = rawMarkers.filter(re => re.test(text)).map(String)
  if (rawHits.length) failures.push({ rule: 'raw-marker', details: rawHits })

  const cardCount = (html.match(/<article\b/gi) || []).length
  const atomCount = (html.match(/data-knowledge-atom=|class="[^"]*\batom\b|class='[^']*\batom\b/gi) || []).length
  if (cardCount >= 30 && atomCount === 0) {
    failures.push({ rule: 'raw-catalog-shape', details: `article_count=${cardCount}, atom_count=${atomCount}` })
  }

  const missing = requiredSignals.filter(signal => !signal.re.test(text)).map(signal => signal.name)
  if (missing.length) failures.push({ rule: 'missing-synthesis-contract', details: missing })

  const sourceLinks = (html.match(/<a\s+[^>]*href=/gi) || []).length
  if (sourceLinks < 3) failures.push({ rule: 'weak-source-expansion', details: `source_links=${sourceLinks}` })

  return failures.length ? { file: path.relative(ROOT, file), failures } : null
}

const reports = await listReports()
if (!reports.length) {
  if (ALLOW_EMPTY) {
    console.log(JSON.stringify({ ok: true, checked: 0, note: 'no reports found (--allow-empty)' }, null, 2))
    process.exit(0)
  }
  console.error(JSON.stringify({ ok: false, checked: 0, error: 'нет отчетов для проверки: 0 найдено (--allow-empty чтобы разрешить)' }, null, 2))
  process.exit(2)
}

const failures = []
for (const report of reports) {
  const failure = await checkReport(report)
  if (failure) failures.push(failure)
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({ ok: true, checked: reports.length }, null, 2))
