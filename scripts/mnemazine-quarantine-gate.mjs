#!/usr/bin/env node
// Карантин зараженного слоя корпуса (план П06 шаг 9). Слой — две оси-детектора:
// «## Атомизировано» (сырье-амнистия) и basename synthesis-*.md. Пересечение пусто.
// Прибор фиксирует границу слоя манифестом и краснеет, если конвейер снова произвел
// зараженную ноту. Ни одна нота при этом не правится — манифест лежит в репозитории.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVault } from './mnemazine-paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(HERE, '..')
const STATE = process.env.MNEMAZINE_STATE || path.join(ROOT, '.mnemazine/state')
const MANIFEST = path.join(STATE, 'quarantine-layer.json')
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

if (argv.includes('--help')) {
  console.log(`mnemazine-quarantine-gate.mjs — граница зараженного слоя корпуса.

Использование: node scripts/mnemazine-quarantine-gate.mjs <режим> [--vault <путь>]
  --build             снять слой (## Атомизировано ∪ synthesis-*.md) в манифест
  --check             пересчитать: рост/новая нота → 1; уменьшение → 0 + потолок вниз
  --check-consumers   поверхности выдачи корпуса ссылаются на манифест? (сегодня 1)
  --vault <путь>      корпус (иначе MNEMAZINE_VAULT или repo-local vault)
  --help              эта справка

Коды возврата: 0 — слой не вырос; 1 — рост/новая нота/манифест подделан/потребители
не подключены; 2 — манифеста нет (--check) или корпус нечитаем.`)
  process.exit(0)
}

const ATOMIZED_RE = /^##\s+Атомизировано(?:\s|$)/m
const isSynthesis = base => /^synthesis-.*\.md$/.test(base)

async function walk(dir, out = []) {
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory()) {
      if (['.git', '.obsidian'].includes(item.name) || item.name.startsWith('graphify-out')) continue
      await walk(path.join(dir, item.name), out)
    } else if (item.isFile() && item.name.endsWith('.md')) {
      out.push(path.join(dir, item.name))
    }
  }
  return out
}

// Слой = список относительных путей нот, попавших хотя бы под один детектор.
async function scanLayer(vault) {
  const layer = []
  for (const file of await walk(vault)) {
    const base = path.basename(file)
    let hit = isSynthesis(base)
    if (!hit) {
      const text = await fs.readFile(file, 'utf8').catch(() => '')
      hit = ATOMIZED_RE.test(text)
    }
    if (hit) layer.push(file)
  }
  const files = []
  for (const file of layer.sort()) {
    files.push({ path: path.relative(vault, file).split(path.sep).join('/'), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') })
  }
  return files
}

async function build(vault) {
  const files = await scanLayer(vault)
  const payload = { vault: path.resolve(vault), files, ceiling: files.length, built_at: new Date().toISOString() }
  await fs.mkdir(STATE, { recursive: true })
  await fs.writeFile(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`карантинный слой снят: ${files.length} нот → ${path.relative(ROOT, MANIFEST)}`)
}

async function check(vault) {
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'))
  } catch {
    console.error(`манифеста карантина нет или он нечитаем: ${MANIFEST} (снять командой --build)`)
    process.exit(2)
  }
  // Подделка манифеста: длина списка обязана равняться потолку. Прибор всегда
  // пишет их согласованными, поэтому ручная дописка пути ломает это равенство.
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.ceiling) {
    console.error(`манифест подделан: files.length=${manifest.files?.length} ≠ ceiling=${manifest.ceiling}`)
    process.exit(1)
  }
  const live = await scanLayer(vault)
  const manifestPaths = new Set(manifest.files.map(f => f.path))
  const appeared = live.filter(f => !manifestPaths.has(f.path))
  if (appeared.length) {
    console.error(`конвейер снова произвел зараженную ноту (${appeared.length} вне манифеста): ${appeared.slice(0, 3).map(f => f.path).join(', ')}`)
    process.exit(1)
  }
  if (live.length > manifest.ceiling) {
    console.error(`слой вырос: ${live.length} > потолка ${manifest.ceiling}`)
    process.exit(1)
  }
  if (live.length < manifest.ceiling) {
    const payload = { vault: path.resolve(vault), files: live, ceiling: live.length, built_at: new Date().toISOString() }
    await fs.writeFile(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`карантинный слой уменьшился: ${manifest.ceiling} → ${live.length}`)
    process.exit(0)
  }
  console.log(`карантинный слой держится: ${live.length} нот`)
  process.exit(0)
}

// Потребители выдачи корпуса обязаны отсекать карантин по манифесту. Сегодня
// они на него не ссылаются — обязательство передается в П14/П18, exit 1.
async function checkConsumers() {
  const consumers = ['scripts/mnemazine-kb-search.mjs', 'config/mcp-vault.json', 'tests/retrieval-eval.mjs']
  const missing = []
  for (const rel of consumers) {
    let text = ''
    try { text = await fs.readFile(path.join(ROOT, rel), 'utf8') } catch { missing.push(`${rel} (нет файла)`); continue }
    if (!text.includes('quarantine-layer.json')) missing.push(rel)
  }
  if (missing.length) {
    console.error(`потребители не отсекают карантин по манифесту: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('все потребители ссылаются на quarantine-layer.json')
  process.exit(0)
}

if (argv.includes('--check-consumers')) await checkConsumers()
else {
  const vault = path.resolve(resolveVault({ cli: arg('vault') }))
  if (argv.includes('--build')) await build(vault)
  else if (argv.includes('--check')) await check(vault)
  else { console.error('нужен режим: --build, --check или --check-consumers (см. --help)'); process.exit(2) }
}
