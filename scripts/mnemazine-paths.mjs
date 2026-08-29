import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for the live knowledge vault.
// Default is the repo-local fixture vault; live runs should set MNEMAZINE_VAULT.
// Override with --vault <path>, MNEMAZINE_VAULT, or .mnemazine/config.json. Fail loud when the resolved
// directory does not exist — silently writing into a missing/wrong tree loses data.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_VAULT = path.join(ROOT, 'vault')

export function resolveVault({ cli, env = process.env.MNEMAZINE_VAULT, requireExists = true } = {}) {
  const explicit = cli || env
  const vault = path.resolve(explicit || configVault() || DEFAULT_VAULT)
  if (requireExists && !fsSync.existsSync(vault)) {
    throw new Error(
      `Vault not found: ${vault}\n` +
      'Set MNEMAZINE_VAULT or pass --vault <path>. Neutral default is repo-local vault/.',
    )
  }
  // Note-count guard (П07) охраняет ТОЛЬКО неявную резолюцию в ЧУЖОЙ маленький корпус:
  // именно config.json, подмененный на не-дефолтный каталог, молча уводит прод на
  // маленький vault. Явный --vault/MNEMAZINE_VAULT — осознанный выбор (фикстуры, демо),
  // а нейтральный репо-дефолт vault/ (40 демо-нот) законно мал и используется смоками
  // (semantic-graph-task, demo) — потолок живого корпуса к нему неприменим.
  if (!explicit && vault !== DEFAULT_VAULT && fsSync.existsSync(vault)) guardVaultNoteCount(vault)
  return vault
}

function configVault() {
  const configPath = path.join(ROOT, '.mnemazine', 'config.json')
  if (!fsSync.existsSync(configPath)) return ''
  try {
    const config = JSON.parse(fsSync.readFileSync(configPath, 'utf8'))
    return typeof config.vault === 'string' ? config.vault : ''
  } catch {
    return ''
  }
}

let warnedMissingCeiling = false

function guardVaultNoteCount(vault) {
  const ceilingPath = path.join(ROOT, '.mnemazine', 'state', 'spec-ceiling.json')
  if (!fsSync.existsSync(ceilingPath)) {
    if (!warnedMissingCeiling) {
      console.error('потолок П06 не снят, защита количества нот неактивна')
      warnedMissingCeiling = true
    }
    return
  }
  let checked = 0
  try {
    checked = Number(JSON.parse(fsSync.readFileSync(ceilingPath, 'utf8')).checked)
  } catch {
    checked = 0
  }
  if (!Number.isFinite(checked) || checked <= 0) return
  const count = countMarkdown(vault)
  if (count < checked) {
    throw new Error(`Vault note-count guard failed: ${vault} has ${count} .md files, below П06 checked ceiling ${checked}.`)
  }
}

function countMarkdown(dir) {
  let count = 0
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('graphify-out')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) count += countMarkdown(file)
    else if (entry.isFile() && entry.name.endsWith('.md')) count += 1
  }
  return count
}
