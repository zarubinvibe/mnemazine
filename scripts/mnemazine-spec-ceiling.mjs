#!/usr/bin/env node
// Потолок провалов спеки (план П16, шаг 8): .mnemazine/state/spec-ceiling.json
// переписывается ТОЛЬКО ВНИЗ и ТОЛЬКО ЭТИМ КОДОМ. Рост провалов — отказ (exit 1),
// ручная правка файла задетектится сверкой sha256 гейта и checked.
//
//   node scripts/mnemazine-spec-ceiling.mjs --update   прогнать гейт и опустить потолок, если провалов стало меньше
//   node scripts/mnemazine-spec-ceiling.mjs --check    сверить: текущие провалы не выше потолка (exit 0/1)
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveVault, ROOT } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)
const UPDATE = argv.includes('--update')
const CHECK = argv.includes('--check')
if (!UPDATE && !CHECK) {
  console.error('нужен --update или --check')
  process.exit(2)
}
function arg(name) {
  const flag = `--${name}`
  const index = argv.findIndex(a => a === flag || a.startsWith(`${flag}=`))
  if (index === -1) return ''
  return argv[index].includes('=') ? argv[index].slice(flag.length + 1) : argv[index + 1] || ''
}
const VAULT = resolveVault({ cli: arg('vault') })
const CEILING_PATH = arg('ceiling') ? path.resolve(arg('ceiling')) : path.join(ROOT, '.mnemazine', 'state', 'spec-ceiling.json')
const GATE = path.join(ROOT, 'scripts', 'mnemazine-vault-quality-gate.mjs')

async function runGate() {
  // JSON уходит в stderr при провалах; код 1 при провалах — ожидаем.
  // Через pipe гейт режет свой JSON: console.error в pipe асинхронен, а process.exit(1)
  // сразу за ним обрывает поток (замерено: ровно 48898 байт). В файл stderr синхронен —
  // поэтому пишем во временный файл редиректом, а не читаем pipe.
  const tmp = path.join(ROOT, '.mnemazine', 'state', '.spec-ceiling-gate.json')
  // .mnemazine/state/ не отслеживается и не публикуется, так что на свежем клоне
  // каталога нет: редирект bash падает молча, а читать становится нечего.
  await fs.mkdir(path.dirname(tmp), { recursive: true })
  execFileSync('bash', ['-c', `node "$1" --spec --json --max-failures=0 > "$2" 2>&1 || true`, '_', GATE, tmp], {
    env: { ...process.env, MNEMAZINE_VAULT: VAULT, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = await fs.readFile(tmp, 'utf8')
  const start = out.indexOf('{')
  if (start === -1) throw new Error(`гейт не вернул JSON: ${out.slice(0, 200)}`)
  return JSON.parse(out.slice(start))
}

const report = await runGate()
const failures = report.failures.length
const checked = report.checked
let ceiling = null
try { ceiling = JSON.parse(await fs.readFile(CEILING_PATH, 'utf8')) } catch { /* первый съем */ }

if (CHECK) {
  if (!ceiling) {
    console.error('потолок не снят — сравнивать не с чем')
    process.exit(1)
  }
  console.log(`сейчас ${failures} провалов, потолок ${ceiling.ceiling}`)
  process.exit(failures <= ceiling.ceiling ? 0 : 1)
}

const sha256 = crypto.createHash('sha256').update(await fs.readFile(GATE)).digest('hex')
if (ceiling && failures >= ceiling.ceiling) {
  console.error(`ОТКАЗ: провалов ${failures} не меньше потолка ${ceiling.ceiling} — потолок НЕ переписан (только вниз)`)
  process.exit(1)
}
const next = { vault: VAULT, checked, ceiling: failures, recorded_at: new Date().toISOString(), sha256_of_gate: sha256 }
await fs.mkdir(path.dirname(CEILING_PATH), { recursive: true })
await fs.writeFile(CEILING_PATH, JSON.stringify(next, null, 2) + '\n')
console.log(`потолок опущен: ${ceiling ? ceiling.ceiling : '—'} → ${failures} (checked ${checked})`)
