#!/usr/bin/env node
// Сторож правила «Session capture stays on: a public repository never stores its
// own checkpoints» (AGENTS.md, раздел Public packaging).
//
// До этого прибора правило якорилось прямо на строку .entire/settings.json, и
// реестр правил зеленел, даже если захват выключить или увести чекпойнты в
// публичный репозиторий: якорь проверял, что строка существует, а не что она
// говорит. Существо держал только семейный гейт снаружи репозитория.
//
// Коды возврата: 0 — правило соблюдено, 1 — нарушено, 2 — нечего проверять
// (файла настроек нет: репозиторий не подключен к трекингу).
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETTINGS = '.entire/settings.json'

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

// Публичный адрес берем из контракта публикации, а не из константы: иначе
// сторож разъедется с репозиторием при переименовании.
async function publicRepoSlug(root) {
  try {
    const release = await readJson(path.join(root, '.github/public-release.json'))
    if (release.public_repository) return String(release.public_repository).toLowerCase()
  } catch { /* пробуем страницу семьи */ }
  try {
    const page = await readJson(path.join(root, '.github/family-page.json'))
    const match = JSON.stringify(page).match(/github\.com[/:]([^/"\s]+\/[^/".\s]+)/)
    if (match) return match[1].toLowerCase()
  } catch { /* адрес не назван */ }
  return null
}

export async function checkTracking(root = ROOT) {
  const settingsPath = path.join(root, SETTINGS)
  let settings
  try {
    settings = await readJson(settingsPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { code: 2, problems: [`${SETTINGS} нет — репозиторий не подключен к трекингу`] }
    return { code: 1, problems: [`${SETTINGS} не читается: ${error.message}`] }
  }

  const problems = []
  if (settings.enabled !== true) {
    problems.push(`${SETTINGS}: enabled = ${JSON.stringify(settings.enabled)}, а захват сессий выключать нельзя`)
  }

  const checkpoint = settings.strategy_options?.checkpoint_remote?.repo
  if (!checkpoint) {
    problems.push(`${SETTINGS}: не назван strategy_options.checkpoint_remote.repo — чекпойнты осядут в самом репозитории`)
  } else {
    const slug = String(checkpoint).toLowerCase()
    const publicSlug = await publicRepoSlug(root)
    if (publicSlug && slug === publicSlug) {
      problems.push(`${SETTINGS}: чекпойнты уходят в публичный ${checkpoint}`)
    }
    if (publicSlug && !slug.endsWith('-checkpoints')) {
      problems.push(`${SETTINGS}: ${checkpoint} не похож на отдельный приватный <repo>-checkpoints`)
    }
  }

  return { code: problems.length ? 1 : 0, problems }
}

async function selftest() {
  const os = await import('node:os')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemazine-tracking-'))
  const write = async (settings, page) => {
    await fs.mkdir(path.join(tmp, '.entire'), { recursive: true })
    await fs.mkdir(path.join(tmp, '.github'), { recursive: true })
    await fs.writeFile(path.join(tmp, SETTINGS), JSON.stringify(settings))
    await fs.writeFile(path.join(tmp, '.github/public-release.json'), JSON.stringify(page))
  }
  const page = { public_repository: 'zarubinvibe/mnemazine' }
  const good = {
    enabled: true,
    strategy_options: { checkpoint_remote: { provider: 'github', repo: 'zarubinvibe/mnemazine-checkpoints' } },
  }
  const cases = []
  await write(good, page)
  cases.push(['настройки в порядке', (await checkTracking(tmp)).code === 0])

  await write({ ...good, enabled: false }, page)
  cases.push(['выключенный захват краснеет', (await checkTracking(tmp)).code === 1])

  await write({ enabled: true, strategy_options: { checkpoint_remote: { repo: 'zarubinvibe/mnemazine' } } }, page)
  cases.push(['чекпойнты в публичный репозиторий краснеют', (await checkTracking(tmp)).code === 1])

  await write({ enabled: true, strategy_options: {} }, page)
  cases.push(['неназванный checkpoint_remote краснеет', (await checkTracking(tmp)).code === 1])

  await fs.rm(path.join(tmp, SETTINGS))
  cases.push(['без файла настроек — код 2', (await checkTracking(tmp)).code === 2])

  await fs.rm(tmp, { recursive: true, force: true })
  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  console.log(failed.length ? `selftest ПРОВАЛЕН: ${cases.length - failed.length}/${cases.length}` : `selftest пройден: ${cases.length}/${cases.length}`)
  return failed.length ? 1 : 0
}

// Путь репозитория содержит кириллицу: import.meta.url приходит в процентной
// кодировке и со строкой из argv не сходится. Сравниваем разобранные пути.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) {
    process.exit(await selftest())
  }
  const { code, problems } = await checkTracking()
  for (const problem of problems) console.error(problem)
  if (code === 0) console.log('захват сессий включен, чекпойнты в отдельном приватном репозитории')
  process.exit(code)
}
