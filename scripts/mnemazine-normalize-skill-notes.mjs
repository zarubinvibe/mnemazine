#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveVault } from './mnemazine-paths.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.split('=').slice(1).join('=')
  return argv[argv.indexOf(hit) + 1] || fallback
}

const VAULT = resolveVault({ cli: arg('vault') })
const APPLY = argv.includes('--apply')
const SKILLS_DIR = path.join(VAULT, '08 AI и Инструменты', 'skills')

const CANON_BLOCK = `## Канон скиллов

- Общая база методики: [[_СПОСОБНОСТИ — методика]], [[2026-06-13 — Каскад роутинга скиллов — local-first с внешним fallback]], [[2026-06-13 — Маркетплейсы скиллов для AI-агентов — skills.sh, SkillHub, SkillsMP]].
- Перед установкой или обновлением: читать \`SKILL.md\`, \`scripts/\`, license, package manager commands и внешние действия.
- Для MCP/plugin/API: read-only по умолчанию, allowlist tools, без секретов в config, write/publish/push только после явного approval владельца.
- При применении знания сначала искать уже доступную локальную способность в [[_СПОСОБНОСТИ — реестр]], а внешний marketplace считать fallback.
`

async function walk(dir) {
  const out = []
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name)
    if (item.name === 'graphify-out' || item.name.startsWith('.')) continue
    if (item.isDirectory()) out.push(...await walk(p))
    else if (item.isFile() && item.name.endsWith('.md') && !item.name.startsWith('_')) out.push(p)
  }
  return out
}

function normalizeFrontmatter(text) {
  if (!text.startsWith('---\n')) return text
  const end = text.indexOf('\n---', 4)
  if (end === -1) return text
  const fm = text.slice(4, end)
  const body = text.slice(end)
  const next = fm
    .replace(/^section:\s*["']?07 Скиллы["']?\s*$/m, 'section: "08 AI и Инструменты"')
    .replace(/^category:\s*["']?Skills["']?\s*$/m, 'category: "AI Skills"')
  return `---\n${next}${body}`
}

const changed = []
for (const file of await walk(SKILLS_DIR)) {
  const rel = path.relative(VAULT, file)
  let text = await fs.readFile(file, 'utf8')
  let next = normalizeFrontmatter(text)

  if (!/^## Канон скиллов\b/m.test(next)) {
    const relatedIndex = next.search(/^## (Применимые способности|Связанные темы|Достоверность|Чек-лист|Опыт практиков)\b/m)
    if (relatedIndex === -1) {
      next = `${next.trimEnd()}\n\n${CANON_BLOCK}\n`
    } else {
      next = `${next.slice(0, relatedIndex).trimEnd()}\n\n${CANON_BLOCK}\n${next.slice(relatedIndex)}`
    }
  }

  if (next !== text) {
    changed.push(rel)
    if (APPLY) await fs.writeFile(file, next)
  }
}

console.log(JSON.stringify({ ok: true, apply: APPLY, changed: changed.length, changed_preview: changed.slice(0, 80) }, null, 2))
