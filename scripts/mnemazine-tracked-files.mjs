// Источник правды о составе дерева для проверок, которым нужен список файлов.
//
// В репозитории это `git ls-files`, и он авторитетен НАРОЧНО: если брать список
// с диска, спрятать прибор можно простым `rm` — проба «спрячь прибор» пройдет
// зеленой (см. mnemazine-release-check.mjs, checkSyntax).
//
// Распакованный релиз — другой случай. Там нет .git, и подменять нечего:
// сравнивать список с чем-то более авторитетным невозможно, потому что ничего
// авторитетнее диска в архиве не существует. Отсутствие репозитория — это не
// поломка проверки, а законная среда, в которой живет чужой человек, скачавший
// tar.gz. Именно на ней ломался изолированный прогон гейта выкладки.
//
// Поэтому: git есть — правду говорит git; репозитория нет — правду говорит диск,
// и вызывающий видит это в поле `source`. Любая ДРУГАЯ ошибка git остается
// провалом, иначе сломанный git тихо превратится в «все хорошо».
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '.mnemazine'])

function walk(root, rel = '', out = []) {
  let entries
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, child, out)
    } else if (entry.isFile()) {
      out.push(child)
    }
  }
  return out
}

function missingRepository(result) {
  if (result.error) return true // git отсутствует на машине
  const err = String(result.stderr || '')
  return /not a git repository|no such file or directory/i.test(err)
}

/**
 * Список файлов дерева.
 * @returns {{ files: string[], source: 'git' | 'disk' }}
 */
export function listTreeFiles(root, args = ['ls-files']) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status === 0) {
    const files = String(result.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    return { files, source: 'git' }
  }
  if (missingRepository(result)) return { files: walk(root).sort(), source: 'disk' }
  throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout || 'unknown error'}`)
}
