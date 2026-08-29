#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

const seed = arg('url')
const apply = argv.includes('--apply')
const graphify = argv.includes('--graphify')
const maxPages = Number(arg('max-pages', '40'))
const VAULT = resolveVault({ cli: arg('vault') })

if (!seed) {
  console.error('Usage: node scripts/mnemazine-ingest-site.mjs --url https://example.com [--apply] [--graphify] [--max-pages 40]')
  process.exit(2)
}

function escMd(s) {
  return String(s || '').replace(/\r/g, '').trim()
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(h[1-4]|p|li|section|article|div)>/gi, '\n')
    .replace(/<h([1-4])[^>]*>/gi, '\n### ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function metaDescription(html) {
  const re = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i
  const alt = /<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i
  return escMd(html.match(re)?.[1] || html.match(alt)?.[1] || '')
}

// Parse <script type="application/ld+json"> blocks; surface @type + name/headline.
function jsonLd(html) {
  const out = []
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim())
      for (const node of Array.isArray(data) ? data : (data['@graph'] || [data])) {
        const type = [].concat(node['@type'] || []).join('/')
        const name = node.name || node.headline || node.title || ''
        if (type || name) out.push(`${type || 'Thing'}${name ? `: ${escMd(String(name)).slice(0, 160)}` : ''}`)
      }
    } catch {}
  }
  return [...new Set(out)].slice(0, 12)
}

// API hints inside same-origin inline JavaScript: REST-ish paths and endpoints.
// ponytail: inline scripts only — linked .js needs extra same-origin fetches;
// add a capped fetch loop here if a target hides its API in external bundles.
function apiHints(html, base) {
  const origin = (() => { try { return new URL(base).origin } catch { return '' } })()
  const js = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n')
  const hints = new Set()
  for (const m of js.matchAll(/["'`](\/(?:api|v\d|graphql|rest|wp-json)\/[A-Za-z0-9_\-\/.{}:]*)["'`]/g)) hints.add(m[1])
  for (const m of js.matchAll(/["'`](https?:\/\/[^"'`\s]+\/(?:api|v\d|graphql)\/[^"'`\s]*)["'`]/g)) {
    try { if (!origin || new URL(m[1]).origin === origin) hints.add(m[1]) } catch {}
  }
  return [...hints].slice(0, 15)
}

// Same-origin links that look like documentation (not just GitHub).
function docLinks(html, base) {
  const out = new Set()
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]
    const label = stripHtml(m[2]).toLowerCase()
    if (/\/(docs?|documentation|guide|reference|api|manual|wiki)\b/i.test(href) ||
        /\b(docs|documentation|guide|reference|api docs|manual)\b/.test(label) ||
        /readthedocs|swagger|openapi|gitbook|docusaurus/i.test(href)) {
      try { out.add(new URL(href, base).href.replace(/#.*$/, '')) } catch {}
    }
  }
  return [...out].slice(0, 15)
}

function slug(value) {
  return String(value || 'site')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'site'
}

async function fetchText(url, optional = false) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mnemazine/0.1 local knowledge ingest' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (err) {
    if (optional) return ''
    throw err
  }
}

function links(html, base) {
  const out = new Set()
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], base)
      if (u.origin === new URL(base).origin) out.add(u.href.replace(/#.*$/, ''))
    } catch {}
  }
  return [...out]
}

async function discover(seedUrl) {
  const origin = new URL(seedUrl).origin
  const urls = new Set([seedUrl])
  const robots = await fetchText(`${origin}/robots.txt`, true)
  const sitemaps = [...robots.matchAll(/Sitemap:\s*(\S+)/gi)].map(m => m[1])
  for (const sm of sitemaps.length ? sitemaps : [`${origin}/sitemap.xml`]) {
    const xml = await fetchText(sm, true)
    for (const m of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
      try {
        const u = new URL(m[1])
        if (u.origin === origin) urls.add(u.href)
      } catch {}
    }
  }
  if (urls.size === 1) {
    const html = await fetchText(seedUrl, true)
    links(html, seedUrl).forEach(u => urls.add(u))
  }
  return [...urls].slice(0, maxPages)
}

function pageNote(url, html) {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url)
  const description = metaDescription(html)
  const text = stripHtml(html)
  const github = [...new Set([...html.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)].map(m => m[0]))]
  const structured = jsonLd(html)
  const api = apiHints(html, url)
  const docs = docLinks(html, url)
  const list = (items, empty) => items.length ? items.map(i => `- ${i}`).join('\n') : `- ${empty}`
  return `# ${title}

## What This Is

This note was created from a public web page and should be refined into smaller durable notes if it contains several topics.

${description ? `> ${description}\n` : ''}
## Source

- URL: ${url}

## Extracted Knowledge

${escMd(text.slice(0, 6000))}

## Structured Data (JSON-LD)

${list(structured, 'No JSON-LD structured data on this page.')}

## Public API Hints

${list(api, 'No same-origin API endpoints detected in inline scripts.')}

## Documentation Links

${list(docs, 'No documentation links found on this page.')}

## Public Repositories Mentioned

${list(github, 'None found on this page.')}

## Verification

- Status: extracted from public page
- Needs: human or agent review before treating as final operational knowledge
`
}

const urls = await discover(seed)
const outDir = path.join(ROOT, '.mnemazine/cache/site-ingest', slug(seed))
await fs.mkdir(outDir, { recursive: true })
const notes = []
for (const url of urls) {
  const html = await fetchText(url, true)
  if (!html.trim()) continue
  const note = pageNote(url, html)
  const file = `${new Date().toISOString().slice(0, 10)}-${slug(url)}.md`
  const target = apply ? path.join(VAULT, '01 Concepts', file) : path.join(outDir, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, note, 'utf8')
  notes.push(target)
}
if (graphify) {
  await import('node:child_process').then(({ spawnSync }) => spawnSync('graphify', ['update', VAULT], { stdio: 'inherit' }))
}
console.log(JSON.stringify({ seed, pages: urls.length, notes: notes.length, applied: apply, output: apply ? VAULT : outDir }, null, 2))
