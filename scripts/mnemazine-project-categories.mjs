import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normSpecValue } from './mnemazine-note-spec.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'config', 'project-categories.json')
const DIRECT = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function load() {
  const data = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const categories = Array.isArray(data.categories) ? data.categories : []
  const byKey = new Map()
  const byNormLabel = new Map()
  for (const item of categories) {
    const key = String(item.key || '').trim()
    const label = String(item.label || '').trim()
    if (!key || !label) throw new Error('config/project-categories.json: category needs key + label')
    if (byKey.has(key)) throw new Error(`config/project-categories.json: duplicate key ${key}`)
    const normLabel = normSpecValue(label)
    if (byNormLabel.has(normLabel)) throw new Error(`config/project-categories.json: duplicate label ${label}`)
    byKey.set(key, label)
    byNormLabel.set(normLabel, label)
  }
  return { byKey, byNormLabel }
}

const registry = load()

export const PROJECT_CATEGORY_LABELS = new Set(registry.byNormLabel.keys())

export function projectCategory(key) {
  const label = registry.byKey.get(key)
  if (!label) throw new Error(`unknown project category key: ${key}`)
  return label
}

export function unknownProjectCategories(values) {
  return values.filter(value => !PROJECT_CATEGORY_LABELS.has(normSpecValue(value)))
}

if (DIRECT) {
  for (const [key, label] of registry.byKey) console.log(`${key}\t${label}`)
}
