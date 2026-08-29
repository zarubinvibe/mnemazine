#!/usr/bin/env node
// Кампания 1 плана П16 — канонизация заголовка блока «Как это поможет мне». Ноль токенов, скрипт, не модель.
//
// Гейт (mnemazine-vault-quality-gate.mjs:269) ищет ^#{2,3}\s+(?:🎯\s*)?Как (?:это )?поможет мне$,
// а в корпусе живут неканонические формы: «Как поможет мне» (222 ноты), «🎯 Как поможет мне» (101)
// и «Как помогает мне» (найдена ручной выборкой шага 0 — гейт ее НЕ видит, это ложный отказ).
// Все три приводятся к канону «Как это поможет мне» (с сохранением 🎯 и уровня заголовка).
//
// По умолчанию — СУХОЙ ПРОГОН, диск не трогается; --apply — opt-in.
// Строки внутри fenced code-блоков не правятся: там заголовок может быть примером синтаксиса.
import { promises as fs } from 'node:fs'
import { resolveVault } from './mnemazine-paths.mjs'
import { corpusFiles } from './mnemazine-normalize-old-frontmatter.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}
const VAULT = resolveVault({ cli: arg('vault') })
const APPLY = argv.includes('--apply')
const JSON_OUT = argv.includes('--json')

// (уровень ##/###)(необязательный 🎯)Как поможет|помогает мне — канон: «Как это поможет мне».
const HEADING = /^(#{2,3}\s+(?:🎯\s*)?)Как помо(?:жет|гает) мне\s*$/

const files = await corpusFiles(VAULT)
const report = { vault: VAULT, apply: APPLY, scanned: files.length, changed: 0, files_changed: [] }
for (const file of files) {
  const text = await fs.readFile(file, 'utf8')
  const lines = text.split('\n')
  let inFence = false
  let touched = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = lines[i].match(HEADING)
    if (m) {
      lines[i] = `${m[1]}Как это поможет мне`
      touched++
    }
  }
  if (!touched) continue
  report.changed++
  report.files_changed.push({ file: file.slice(VAULT.length + 1), headings: touched })
  if (APPLY) await fs.writeFile(file, lines.join('\n'))
}
if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${APPLY ? 'ПРИМЕНЕНО' : 'СУХОЙ ПРОГОН'} · vault ${report.vault}`)
  console.log(`просмотрено ${report.scanned} · файлов с правкой ${report.changed}`)
  for (const f of report.files_changed) console.log(`  ${f.file} (${f.headings})`)
}
