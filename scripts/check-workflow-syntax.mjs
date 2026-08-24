#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const HOOK_NAMES = ['args', 'agent', 'parallel', 'phase', 'log']
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function findMeta(source) {
  const match = /(^|\n)\s*export\s+const\s+meta\s*=/.exec(source)
  if (!match) throw new SyntaxError('export const meta block not found')

  const objectStart = source.indexOf('{', match.index + match[0].length)
  if (objectStart === -1) throw new SyntaxError('export const meta object not found')

  let depth = 0
  let quote = ''
  let lineComment = false
  let blockComment = false

  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      if (ch === '\\') {
        i += 1
      } else if (ch === quote) {
        quote = ''
      }
      continue
    }

    if (ch === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start: match.index, objectStart, end: i }
    }
  }

  throw new SyntaxError('export const meta object is not closed')
}

export function workflowBody(source) {
  const meta = findMeta(source)
  const metaText = source.slice(meta.objectStart, meta.end + 1)
  new Function(`return (${metaText})`)

  let suffix = source.slice(meta.end + 1)
  suffix = suffix.replace(/^\s*;?/, '')
  return source.slice(0, meta.start) + suffix
}

export function checkSource(source) {
  const body = workflowBody(source)
  new AsyncFunction(...HOOK_NAMES, body)
}

function selftest() {
  const good = "export const meta = { name: 'ok', phases: [{ title: 'Guard' }] }\nconst x = 1\nif (x) return { ok: true }\n"
  const badBody = "export const meta = { name: 'bad' }\nif (\n"
  const badImportMeta = "export const meta = { name: 'bad-import-meta' }\nreturn import.meta.url\n"

  checkSource(good)

  for (const [name, source] of [['bad-body', badBody], ['bad-import-meta', badImportMeta]]) {
    let failed = false
    try {
      checkSource(source)
    } catch {
      failed = true
    }
    if (!failed) throw new Error(`selftest ${name} unexpectedly passed`)
  }

  console.log('selftest ok')
}

function main() {
  if (process.argv.includes('--selftest')) {
    selftest()
    return
  }

  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: node scripts/check-workflow-syntax.mjs <workflow.js> [...]')
    process.exit(2)
  }

  for (const file of files) {
    checkSource(readFileSync(file, 'utf8'))
    console.log(`ok ${file}`)
  }
}

main()
