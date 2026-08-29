#!/usr/bin/env node
// ПРИБОР КРИТЕРИЯ 3 (память агентов) — мастер §4. Контракт, а не документ о контракте.
//
// Коды выхода (мастер §4):
//   0 — контракт жив: граф на месте и свежее последней ноты, MCP-сервер стартует и отвечает,
//       канал заявок жив, зомби-задач нет, ответ сервера несет поле subject (§18.4).
//   1 — любое звено мертво.
//   2 — граф не найден (отличаем «нет графа» от «звено мертво» — враждебная проба П18).
//
// Живой vault: MNEMAZINE_VAULT → --vault → резолвер (личный vault по rules/structure.md).
// Путь к графу берется из шаблона config/mcp-vault.json и ВЫЧИСЛЯЕТСЯ из MNEMAZINE_VAULT,
// а не зашит — иначе шаблон протухнет на чужой машине.
//
// Флаги:
//   --fix-config <path>   привести шаблон mcp-vault.json к вычисляемому пути (идемпотентно)
//   --reap-stale-tasks    зомби: status:running при мертвом PID → stale, код 1
//   --require-channel-proof  дополнительно требовать живой заявки, прошедшей воронку инбокса
//   --json                машинный вывод
import { parseArgs } from 'node:util'
import { promises as fs, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveVault } from './mnemazine-paths.mjs'
import os from 'node:os'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const CONFIG_TEMPLATE = path.join(REPO, 'config', 'mcp-vault.json')
const SEMANTIC_TASK = path.join(REPO, '.mnemazine', 'state', 'semantic-graph-task.json')
const INBOX = process.env.MNEMAZINE_INBOX || path.join(HOME, 'Desktop', 'Mnemazine Inbox')
const STUB = '/path/to/vault'
const PROBE_TIMEOUT_MS = 30000

// --- Резолвинг живого vault и графа --------------------------------------------------------------
function resolveLiveVault(cli) {
  const v = cli || process.env.MNEMAZINE_VAULT || resolveVault({ requireExists: false })
  return path.resolve(v)
}

/** Раскрывает ${MNEMAZINE_VAULT}, $MNEMAZINE_VAULT, ведущий ~ в аргументе шаблона. */
function expandPath(raw, vault) {
  return raw
    .replace(/\$\{MNEMAZINE_VAULT\}/g, vault)
    .replace(/\$MNEMAZINE_VAULT\b/g, vault)
    .replace(/^~(?=\/)/, HOME)
}

/** Достает последний аргумент (путь к графу) из шаблона mcp-vault.json. */
function templateGraphArg() {
  const j = JSON.parse(readFileSync(CONFIG_TEMPLATE, 'utf8'))
  const args = j?.mcpServers?.['vault-graph']?.args
  if (!Array.isArray(args) || !args.length) throw new Error('mcp-vault.json: нет mcpServers.vault-graph.args')
  return String(args[args.length - 1])
}

// --- MCP-проба: полный handshake по line-delimited JSON-RPC, тот же транспорт, что у Claude --------
function mcpProbe(graphPath) {
  return new Promise(resolve => {
    const child = spawn('python3', ['-m', 'graphify.serve', graphPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map()
    let idc = 1, buf = '', errbuf = '', settled = false
    const finish = out => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL') } catch {}; resolve(out) }
    const timer = setTimeout(() => finish({ alive: false, reason: 'timeout', stderr: errbuf.slice(0, 400) }), PROBE_TIMEOUT_MS)
    child.on('error', e => finish({ alive: false, reason: `spawn: ${e.message}` }))
    child.stderr.on('data', d => { errbuf += d })
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let m; try { m = JSON.parse(line) } catch { continue }
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      }
    })
    const send = (method, params) => new Promise(res => {
      const id = idc++; pending.set(id, res)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    ;(async () => {
      try {
        const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-memory-check', version: '1' } })
        if (init.error) return finish({ alive: false, reason: `initialize: ${JSON.stringify(init.error)}` })
        notify('notifications/initialized', {})
        const tools = (await send('tools/list', {})).result?.tools?.map(t => t.name) || []
        // god_nodes дает гарантированно существующий label → get_node на нем проверяет контракт subject.
        const god = await send('tools/call', { name: 'god_nodes', arguments: { top_n: 1 } })
        const godText = (god.result?.content || []).map(c => c.text).join('\n')
        const label = (godText.match(/\d+\.\s+(.+?)\s+-\s+\d+\s+edges/) || [])[1] || ''
        let nodeText = ''
        if (label) {
          const node = await send('tools/call', { name: 'get_node', arguments: { label } })
          nodeText = (node.result?.content || []).map(c => c.text).join('\n')
        }
        const hasSubject = /^\s*Subject\s*:/im.test(nodeText)
        finish({ alive: true, serverInfo: init.result?.serverInfo || null, tools, probeLabel: label, nodeText, hasSubject })
      } catch (e) { finish({ alive: false, reason: e.message, stderr: errbuf.slice(0, 400) }) }
    })()
  })
}

// --- Свежесть графа: mtime графа против самой свежей ноты + маркер needs_update --------------------
const NON_CODE = new Set(['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.gif'])
async function newestNoteMtime(vault) {
  let newest = 0
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('graphify-out') || e.name === '.git' || e.name === '.obsidian') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && NON_CODE.has(path.extname(e.name).toLowerCase())) {
        const s = await fs.stat(p).catch(() => null)
        if (s) newest = Math.max(newest, s.mtimeMs)
      }
    }
  }
  await walk(vault)
  return newest
}

// --- Зомби-задача: живость PID, не поле status ---------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } // EPERM = жив, но чужой
}
function reapStaleTasks() {
  if (!existsSync(SEMANTIC_TASK)) return { zombie: false, reaped: false, note: 'файла задачи нет' }
  let t
  try { t = JSON.parse(readFileSync(SEMANTIC_TASK, 'utf8')) } catch { return { zombie: true, reaped: false, note: 'нечитаемый json' } }
  if (t.status !== 'running') return { zombie: false, reaped: false, status: t.status }
  if (pidAlive(t.pid)) return { zombie: false, reaped: false, status: 'running', pid: t.pid }
  const next = { ...t, status: 'stale', running: false, reaped_at: new Date().toISOString(), reaped_reason: `pid ${t.pid} мертв при status:running` }
  writeFileSync(SEMANTIC_TASK, JSON.stringify(next, null, 2) + '\n')
  return { zombie: true, reaped: true, pid: t.pid }
}

// --- Канал заявок: живая заявка, прошедшая воронку инбокса ----------------------------------------
async function channelProof(vault) {
  // Проба: нота type: agent-research в корпусе (не шаблон), source: которой указывает на файл-заявку.
  const notes = []
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('graphify-out') || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && e.name.endsWith('.md')) {
        const head = readFileSync(p, 'utf8').slice(0, 1200)
        if (/^type:\s*"?agent-research"?/m.test(head) && !/_ШАБЛОНЫ|_TEMPLATES|template/i.test(p) &&
            /^sources?:.*agent-research--/m.test(head)) notes.push(p)
      }
    }
  }
  await walk(vault)
  const inboxLive = existsSync(INBOX)
  return { inboxLive, proofNotes: notes, proven: notes.length > 0 }
}

// --- fix-config: привести шаблон к вычисляемому пути (идемпотентно) -------------------------------
function fixConfig(target) {
  const file = target || CONFIG_TEMPLATE
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const args = j?.mcpServers?.['vault-graph']?.args
  if (!Array.isArray(args) || !args.length) throw new Error('нет mcpServers.vault-graph.args')
  const want = '${MNEMAZINE_VAULT}/graphify-out/graph.json'
  const last = String(args[args.length - 1])
  if (last === want) return { changed: false, path: last }
  args[args.length - 1] = want
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
  return { changed: true, from: last, to: want }
}

// --- Главная сборка ------------------------------------------------------------------------------
async function run({ vault: cliVault, requireChannelProof, json }) {
  const vault = resolveLiveVault(cliVault)
  const links = []
  const add = (name, ok, detail) => links.push({ name, ok, detail })

  // Звено 0: шаблон вычисляем и без заглушки.
  let templateArg, graphPath
  try {
    templateArg = templateGraphArg()
    graphPath = expandPath(templateArg, vault)
    const clean = !templateArg.includes(STUB)
    const computed = /\$\{?MNEMAZINE_VAULT/.test(templateArg) || templateArg.includes(vault)
    add('template', clean && computed, { templateArg, graphPath, clean, computed })
  } catch (e) {
    add('template', false, { error: e.message })
    return report(links, 2, vault, json) // без шаблона граф не найти
  }

  // Звено 1: граф найден (иначе код 2).
  const graphFound = existsSync(graphPath)
  add('graph_found', graphFound, { graphPath })
  if (!graphFound) return report(links, 2, vault, json)

  // Звено 2: граф свежее последней ноты И нет needs_update.
  const graphMtime = statSync(graphPath).mtimeMs
  const needsUpdate = existsSync(path.join(vault, 'graphify-out', 'needs_update'))
  const newest = await newestNoteMtime(vault)
  const fresh = graphMtime >= newest && !needsUpdate
  add('graph_fresh', fresh, {
    graph_mtime: new Date(graphMtime).toISOString(),
    newest_note: newest ? new Date(newest).toISOString() : null,
    needs_update: needsUpdate,
  })

  // Звено 3: зомби-задач нет.
  const z = reapStaleTasks()
  add('no_zombie', !z.zombie, z)

  // Звено 4+5: сервер стартует, отвечает, и ответ несет поле subject (§18.4).
  const probe = await mcpProbe(graphPath)
  add('server_alive', probe.alive, { serverInfo: probe.serverInfo, tools: probe.tools, reason: probe.reason, stderr: probe.stderr })
  add('subject_contract', probe.alive ? probe.hasSubject : false, {
    probeLabel: probe.probeLabel,
    hasSubject: probe.hasSubject,
    note: probe.alive && !probe.hasSubject
      ? 'ответ get_node не несет поля Subject: серверный шаблон graphify 1.8.1 его не отдает и граф не хранит subject на узлах — §18.4 не замкнуто'
      : undefined,
  })

  // Звено 6: канал заявок.
  const ch = await channelProof(vault)
  add('channel', requireChannelProof ? ch.proven : ch.inboxLive, ch)

  const code = links.every(l => l.ok) ? 0 : 1
  return report(links, code, vault, json)
}

function report(links, code, vault, json) {
  if (json) {
    console.log(JSON.stringify({ ok: code === 0, code, vault, links }, null, 2))
  } else {
    console.log(`ПАМЯТЬ АГЕНТОВ — критерий 3 (vault: ${vault})`)
    for (const l of links) console.log(`  ${l.ok ? '✓' : '✗'} ${l.name}${l.ok ? '' : '  ← ' + (l.detail?.note || l.detail?.reason || l.detail?.error || JSON.stringify(l.detail))}`)
    console.log(code === 0 ? 'контракт жив (0)' : code === 2 ? 'граф не найден (2)' : 'звено мертво (1)')
  }
  return code
}

async function selftest() {
  const { strictEqual: eq, ok } = await import('node:assert')
  eq(expandPath('${MNEMAZINE_VAULT}/graphify-out/graph.json', '/V'), '/V/graphify-out/graph.json')
  eq(expandPath('$MNEMAZINE_VAULT/g.json', '/V'), '/V/g.json')
  eq(expandPath('~/vault-dir/g.json', 'x'), path.join(HOME, 'vault-dir/g.json'))
  eq(pidAlive(process.pid), true)     // сам процесс жив
  eq(pidAlive(2 ** 31 - 1), false)    // невозможный pid мертв
  eq(pidAlive(0), false)
  ok(templateGraphArg().includes('MNEMAZINE_VAULT'), 'шаблон вычисляем из MNEMAZINE_VAULT')
  ok(!templateGraphArg().includes(STUB), 'в шаблоне нет заглушки')
  console.log('selftest ok')
  return 0
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      vault: { type: 'string' },
      'fix-config': { type: 'string' },
      'reap-stale-tasks': { type: 'boolean' },
      'require-channel-proof': { type: 'boolean' },
      selftest: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  })

  if (v.selftest) return selftest()
  if (v['fix-config'] !== undefined) {
    const r = fixConfig(v['fix-config'] || undefined)
    console.log(v.json ? JSON.stringify(r) : (r.changed ? `шаблон исправлен: ${r.from} → ${r.to}` : `шаблон уже вычисляем: ${r.path}`))
    return 0
  }
  if (v['reap-stale-tasks']) {
    const r = reapStaleTasks()
    console.log(v.json ? JSON.stringify(r) : (r.zombie ? `зомби ${r.reaped ? 'снят' : 'найден'}: pid ${r.pid} — ${r.note || 'status:running при мертвом pid'}` : `зомби-задач нет (${r.status || r.note || 'ok'})`))
    return r.zombie ? 1 : 0
  }
  return run({ vault: v.vault, requireChannelProof: v['require-channel-proof'], json: v.json })
}

main().then(c => process.exit(c)).catch(e => { console.error(e?.message || e); process.exit(1) })
