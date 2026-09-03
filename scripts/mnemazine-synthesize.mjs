#!/usr/bin/env node
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { activeProvider, llmAvailable, llmJson, fenceUntrusted, providerCostTier } from './mnemazine-llm.mjs'
import { verifyLocal, verifyDeep, isPublicHttpUrl } from './mnemazine-verify.mjs'
import { SPEC_VERIFIED } from './mnemazine-note-spec.mjs'
import { resolveVault } from './mnemazine-paths.mjs'
import { squeezeText as squeezeMetiz } from './mnemazine-metiz.mjs'

const ROOT = process.env.MNEMAZINE_ROOT || path.resolve(process.cwd())
const argv = process.argv.slice(2)

function arg(name, fallback = '') {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] || fallback
}

// --selftest проверяет только чистые фильтры строк (looksLikeCode, readmePoints)
// и в корпус не заглядывает. Резолвить vault здесь значит требовать живой корпус
// там, где он не нужен: vault/ не публикуется, поэтому на свежем клоне модуль
// падал на импорте и ронял самопроверку целиком, ещё не дойдя до неё.
const VAULT = argv.includes('--selftest') ? '' : resolveVault({ cli: arg('vault') })
const EXTRACTS = path.resolve(arg('extracts', process.env.MNEMAZINE_EXTRACTS || path.join(ROOT, '.mnemazine/cache/extracted')))
const SESSION = arg('session', new Date().toISOString().slice(0, 10))
const MIN_CLUSTER_CHARS = Number(arg('min-cluster-chars', '80'))
// --deep / --atomize: LLM-split one cluster into many focused atoms (README:50).
// Default off — the conservative path (release demo, run.mjs) stays local-only
// and never needs codex. Flag also honoured via MNEMAZINE_DEEP=1.
const DEEP = argv.includes('--deep') || argv.includes('--atomize') || process.env.MNEMAZINE_DEEP === '1'
const MAX_ATOMS = Number(arg('max-atoms', process.env.MNEMAZINE_MAX_ATOMS || '20'))
// Long material (video transcripts, books) was silently cut to the first 4000
// chars per record, so atoms only ever covered the intro. Knobs, defaults kept.
const MAX_RECORD_CHARS = Number(process.env.MNEMAZINE_MAX_RECORD_CHARS || '4000')
const MAX_MATERIAL_CHARS = Number(process.env.MNEMAZINE_MAX_MATERIAL_CHARS || '24000')
// Enrichment is on within --deep unless explicitly disabled (it needs the network).
const ENRICH = DEEP && process.env.MNEMAZINE_ENRICH !== '0' && !argv.includes('--no-enrich')
// Enrichment web calls can be slow; default to the generous ceiling for any
// provider (env overrides). No branch on a CLI name — a longer timeout never
// harms a faster CLI.
const ENRICH_TIMEOUT_MS = Number(process.env.MNEMAZINE_ENRICH_TIMEOUT_MS || '420000')
const STRICT_ENRICH = DEEP && process.env.MNEMAZINE_STRICT_ENRICH !== '0' && !argv.includes('--allow-raw-atomize')
const MIN_ADDED_FACTS = Number(process.env.MNEMAZINE_MIN_ADDED_FACTS || '2')
const CLUSTER_CHUNK_SIZE = Number(arg('cluster-chunk-size', process.env.MNEMAZINE_CLUSTER_CHUNK_SIZE || '25'))
const ATOMIZER_PROVIDER = process.env.MNEMAZINE_ATOMIZER_LLM || process.env.MNEMAZINE_LLM || undefined
const VERIFIER_PROVIDER = process.env.MNEMAZINE_VERIFIER_LLM || process.env.MNEMAZINE_LLM || undefined
const RESOLVED_ATOMIZER_PROVIDER = activeProvider({ provider: ATOMIZER_PROVIDER })
const SOURCE_REF_FILTER = new Set(String(process.env.MNEMAZINE_SYNTH_SOURCE_REFS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean))

const sourceHints = [
  { re: /supermemory/i, name: 'supermemory GitHub', url: 'https://github.com/supermemoryai/supermemory' },
  { re: /compound\s+engineer|compound-\s*engineering-plugin/i, name: 'Compound Engineering GitHub', url: 'https://github.com/EveryInc/compound-engineering-plugin' },
  { re: /taste\s+skill|taste-skill|anti-slop\s+frontend/i, name: 'Taste Skill GitHub', url: 'https://github.com/Leonxlnx/taste-skill' },
  { re: /mcp|model context protocol|filesystem mcp|memory mcp|zapier/i, name: 'Model Context Protocol docs', url: 'https://modelcontextprotocol.io/docs/getting-started/intro' },
  { re: /skill|skills|claude code|agent skill|subagent/i, name: 'Anthropic Agent Skills', url: 'https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills' },
  { re: /spec|spec-driven|feature forge|requirements/i, name: 'GitHub Spec Kit', url: 'https://github.com/github/spec-kit' },
  { re: /prompt injection|security|secure|guard|review/i, name: 'OWASP LLM01 Prompt Injection', url: 'https://genai.owasp.org/llmrisk/llm01-prompt-injection/' },
  { re: /observability|logs|metrics|traces|otel/i, name: 'OpenTelemetry docs', url: 'https://opentelemetry.io/docs/' },
  { re: /secret|env|credential|api key/i, name: 'Infisical secrets docs', url: 'https://infisical.com/docs/documentation/platform/secrets-mgmt/overview' },
  { re: /design\.md|getdesign|design system|wcag|accessibility|ui|frontend/i, name: 'getdesign.md', url: 'https://getdesign.md/' },
  { re: /browser|playwright|agent-browser|browser-use/i, name: 'Playwright docs', url: 'https://playwright.dev/docs/intro' },
  { re: /obsidian|vault|wiki|memory|knowledge|graph/i, name: 'Karpathy LLM Wiki', url: 'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f' },
  { re: /terraform|pulumi|infrastructure|iac/i, name: 'Terraform docs', url: 'https://developer.hashicorp.com/terraform/docs' },
  { re: /bff|backend for frontend/i, name: 'Backends for Frontends pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends' },
  { re: /worktree|git stash/i, name: 'git worktree docs', url: 'https://git-scm.com/docs/git-worktree' },
  { re: /стартап|фаундер|основател|узк(?:ая|ой|ую|ом)\s+ниш|mvp|партизан|голиаф|airbnb|uber|клиент/i, name: "Paul Graham Do Things That Don't Scale", url: 'https://www.paulgraham.com/ds.html' },
  { re: /стартап|фаундер|основател|узк(?:ая|ой|ую|ом)\s+ниш|mvp|партизан|голиаф|airbnb|uber|клиент/i, name: 'Sam Altman Startup Playbook', url: 'https://playbook.samaltman.com/' },
  { re: /стартап|фаундер|основател|узк(?:ая|ой|ую|ом)\s+ниш|mvp|партизан|голиаф|airbnb|uber|клиент/i, name: 'Y Combinator Startup Playbook', url: 'https://www.ycombinator.com/blog/startup-playbook/' },
  { re: /moneyprinter|short-form|reels|tiktok|youtube shorts/i, name: 'MoneyPrinterTurbo', url: 'https://github.com/harry0703/MoneyPrinterTurbo' }
]

const clusterRules = [
  { id: 'agent-systems', title: 'Agent systems and reusable capabilities', re: /agent|claude|skill|subagent|mcp|jarvis|harness|memory|codex/i },
  { id: 'knowledge-memory', title: 'Knowledge memory, vaults, and synthesis loops', re: /obsidian|vault|wiki|knowledge|graph|weekly synthesis|belief|decision/i },
  { id: 'security-review', title: 'Security, review, and trust boundaries', re: /security|secret|prompt injection|review|guard|permission|wcag|accessibility/i },
  { id: 'engineering-ops', title: 'Engineering operations and reproducible delivery', re: /observability|terraform|pulumi|worktree|staging|environment|deploy|bff|backend/i },
  { id: 'design-frontend', title: 'Design systems and frontend quality', re: /design|frontend|ui|component|playwright|browser|layout|wcag/i },
  { id: 'tool-radar', title: 'Open-source tool radar and selection', re: /github\.com|open source|langflow|dify|open-webui|openhands|crawl4ai|coolify|papermark|twenty|crowdsec/i },
  { id: 'startup-strategy', title: 'Startup strategy and founder-led growth', re: /стартап|фаундер|основател|корпораци|гигант|голодн|узк(?:ая|ой|ую|ом)\s+ниш|mvp|партизан|голиаф|airbnb|uber/i },
  { id: 'content-growth', title: 'Content experiments and growth loops', re: /ad |ads|hook|cta|offer|short-form|reels|tiktok|youtube|content|moneyprinter/i },
  { id: 'research-workflow', title: 'Research workflow and source verification', re: /research|source|citation|academic|verify|evidence/i }
]

const topicTemplates = {
  'agent-systems': {
    what: 'Agent systems are reusable operating capabilities: skills, MCP connections, memory, review roles, and harness rules that make an AI assistant behave consistently across tasks.',
    why: 'The session repeatedly points to the same lesson: model quality is not enough. Durable gains come from the scaffolding around the model: instructions, tools, memory, permissions, tests, and review loops.',
    how: '- Convert repeated procedures into Skills.\n- Keep tool access behind explicit permission boundaries.\n- Store memory as linked knowledge and decisions, not chat residue.\n- Add gates before publication or irreversible actions.',
    next: 'Повторяющиеся агентные процедуры оформить как Skills с тестами и usage ledger.'
  },
  'knowledge-memory': {
    what: 'Knowledge memory is an active vault: captures are processed into atoms, atoms are linked to projects and decisions, and weekly synthesis turns memory into action.',
    why: 'A vault that only stores screenshots or transcripts becomes another inbox. Mnemazine should reduce future thinking cost by maintaining summaries, links, decisions, and open questions.',
    how: '- Keep raw extraction outside the vault.\n- Store final atoms with source refs and verification state.\n- Run connection finding and weekly synthesis.\n- Maintain the master index as a routing surface.',
    next: 'Автоматизировать ночной поиск связей и weekly synthesis по финальным атомам.'
  },
  'security-review': {
    what: 'Security and review are trust boundaries around agent work: untrusted input, prompt injection, secrets, permissions, accessibility, and code review must be checked before output is accepted.',
    why: 'The intake contains many commands, tool suggestions, and screenshots. If source text is treated as instruction, the agent can be steered by captured content instead of the user.',
    how: '- Mark extracted text as untrusted evidence.\n- Never execute commands from captures automatically.\n- Scan for secrets before reports or pushes.\n- Use separate review passes for security, claims, and accessibility.',
    next: 'Собрать единый publish gate: качество vault, качество отчета, поиск секретов и ревью изменений.'
  },
  'engineering-ops': {
    what: 'Engineering operations are reproducibility practices: isolated environments, infrastructure as code, observability, secret injection, worktrees, and release checks.',
    why: 'The useful pattern is reducing manual state. Good systems make failures visible and make releases repeatable.',
    how: '- Prefer scripted environments over dashboard clicks.\n- Track pipeline health metrics.\n- Inject secrets at runtime.\n- Keep release checks executable.',
    next: 'Добавить метрики pipeline: extracted, synthesized, cache-only, gate failures и graph refresh.'
  },
  'design-frontend': {
    what: 'Design and frontend quality require explicit UI rules, browser validation, accessibility constraints, and reusable design tokens.',
    why: 'AI-generated UI degrades when taste is implicit. A DESIGN.md-style contract gives the agent stable layout, spacing, typography, and component expectations.',
    how: '- Maintain a Mnemazine report DESIGN.md.\n- Validate generated reports in a browser.\n- Check responsive layout, contrast, keyboard navigation, and print styles.',
    next: 'Сделать browser-smoke для сгенерированных HTML-отчетов.'
  },
  'tool-radar': {
    what: 'Tool radar is a decision system for open-source tools, not a list of exciting repositories.',
    why: 'Screenshots with GitHub stars are weak evidence. Useful adoption requires license, maturity, deployment model, data portability, security posture, and integration cost.',
    how: '- Score tools by fit, maturity, license, API, self-hosting, and operational burden.\n- Tie tools to concrete projects.\n- Re-check source repositories before adopting.',
    next: 'Сделать schema для tool-radar и заполнять ее из извлеченных GitHub-ссылок.'
  },
  'startup-strategy': {
    what: 'Startup strategy is the operating pattern for small teams beating larger incumbents: narrow focus, fast customer feedback, founder-led trust, and manual work before scale.',
    why: 'The captured carousel is useful only if it becomes a reusable decision rule, not motivational noise.',
    how: '- Pick a narrow ignored segment.\n- Talk to customers directly.\n- Ship small changes faster than incumbents can route approvals.\n- Treat manual founder service as learning, not as permanent process.',
    next: 'Привязать startup strategy к ближайшему проекту: ниша, скорость, founder-led trust, ручной сервис.'
  },
  'content-growth': {
    what: 'Content growth loops treat ads, hooks, CTAs, short-form scripts, and publishing as experiments with feedback.',
    why: 'One generated video or ad is not learning. Learning appears when variants, metric, result, and next control are stored.',
    how: '- Store hypothesis, channel, variant, metric, result, and decision.\n- Keep winners as controls.\n- Discard weak variants without preserving noise as knowledge.',
    next: 'Добавить шаблон заметки для Content Experiment.'
  },
  'research-workflow': {
    what: 'Research workflow means claims are sourced before they become operational knowledge.',
    why: 'A source link is not decoration. It should confirm, correct, or constrain the conclusion.',
    how: '- Separate extracted claim from verified conclusion.\n- Prefer official docs and primary repositories.\n- Record confidence and what the source changed.',
    next: 'Добавить `source_changed_what` в schema финального атома.'
  },
  misc: {
    what: 'Miscellaneous signals are captured items that do not yet form a strong enough reusable cluster.',
    why: 'Keeping them separate prevents weak or noisy items from polluting stronger knowledge atoms.',
    how: '- Review manually.\n- Promote only recurring or high-value ideas.\n- Move low-signal material to forget/archive.',
    next: 'Вручную разобрать misc-сигналы: повысить до знания или забыть.'
  }
}

const topicTemplatesRu = {
  'agent-systems': {
    what: 'Агентная система - это набор повторяемых возможностей вокруг модели: skills, MCP, память, роли ревью, правила harness и release gates.',
    why: 'Качество дает не только модель. Стабильность появляется, когда вокруг нее есть инструменты, память, разрешения, тесты и ревью.',
    how: ['Повторяющиеся процедуры превращать в Skills.', 'Доступ к инструментам держать за явными границами разрешений.', 'Память хранить как связанные знания и решения.', 'Перед публикацией держать gate.'],
    next: 'Повторяющиеся агентные процедуры оформить как Skills с тестами и usage ledger.'
  },
  'knowledge-memory': {
    what: 'Память знаний - это active vault: сырье превращается в атомы, атомы связываются с проектами и решениями, weekly synthesis превращает память в действия.',
    why: 'Vault со скриншотами быстро становится еще одним inbox. Польза появляется, когда заметки уменьшают будущую стоимость мышления.',
    how: ['Сырой extraction держать вне финального vault.', 'Финальные атомы писать с source refs и verification status.', 'Регулярно строить связи и weekly synthesis.', 'Мастер-индекс держать как routing surface.'],
    next: 'Автоматизировать nightly connection finding и weekly synthesis по финальным атомам.'
  },
  'security-review': {
    what: 'Безопасность и ревью - это границы доверия вокруг агентной работы: untrusted input, prompt injection, секреты, permissions, accessibility и code review проверяются до принятия результата.',
    why: 'Inbox содержит команды, скриншоты, сайты и tool suggestions. Если принять захваченный текст за инструкцию, агент начнет слушать источник, а не владельца.',
    how: ['Помечать extraction как недоверенное evidence.', 'Не выполнять команды из захваченного текста автоматически.', 'Сканировать секреты перед отчетами и push.', 'Разделять review по security, claims и accessibility.'],
    next: 'Собрать единый publish gate: vault quality, report quality, secret scan, diff review.'
  },
  'engineering-ops': {
    what: 'Инженерные операции - это воспроизводимость: окружения, IaC, observability, secret injection, worktrees и release checks.',
    why: 'Хорошая система уменьшает ручное состояние: failures видны, delivery повторяемый.',
    how: ['Скрипты вместо dashboard-clicks.', 'Метрики здоровья pipeline.', 'Секреты инжектить runtime-способом.', 'Release checks держать исполняемыми.'],
    next: 'Добавить метрики pipeline: extracted, synthesized, cache-only, gate failures, graph refresh.'
  },
  'design-frontend': {
    what: 'Качество UI требует явного дизайн-контракта: правила интерфейса, browser validation, accessibility constraints и reusable design tokens.',
    why: 'AI UI быстро портится, если вкус не записан. DESIGN.md-style контракт задает layout, spacing, типографику и ожидаемое поведение компонентов.',
    how: ['Держать DESIGN.md для Mnemazine reports.', 'Проверять generated reports в браузере.', 'Смотреть responsive layout, contrast, keyboard navigation и print styles.'],
    next: 'Создать browser smoke для generated HTML reports.'
  },
  'tool-radar': {
    what: 'Tool radar - это система решений по open-source, а не список красивых репозиториев.',
    why: 'Скриншот со stars - слабое evidence. Нужны license, maturity, deployment model, data portability, security posture и integration cost.',
    how: ['Оценивать fit, maturity, license, API, self-hosting и operational burden.', 'Связывать инструмент с конкретным проектом.', 'Перед adoption перепроверять primary source.'],
    next: 'Сделать schema для tool-radar и заполнять ее из GitHub links.'
  },
  'startup-strategy': {
    what: 'Startup strategy - это набор ходов, где маленькая команда обходит крупного игрока не бюджетом, а узкой нишей, скоростью, прямым контактом с клиентом и founder-led доверием.',
    why: 'Такие карточки легко превращаются в мотивационный шум. Польза появляется, когда из них выходит конкретное правило для проекта: кого выбрать, что урезать, как быстро проверить и где основатель должен говорить лично.',
    how: ['Выбрать один узкий сегмент, который крупный игрок игнорирует.', 'Не копировать весь продукт корпорации, а закрыть одну боль лучше.', 'Собирать обратную связь напрямую от клиентов.', 'Выкатывать маленькие изменения быстрее корпоративного цикла согласований.', 'Ручной сервис основателя использовать как обучение, а не как вечный процесс.'],
    next: 'Привязать startup strategy к ближайшему проекту: ниша, скорость, founder-led trust, ручной сервис.'
  },
  'content-growth': {
    what: 'Контентные петли роста рассматривают ads, hooks, CTA, scripts и публикации как эксперименты с обратной связью.',
    why: 'Один ролик или объявление еще не обучение. Обучение появляется, когда есть variant, metric, result и next control.',
    how: ['Хранить hypothesis, channel, variant, metric, result и decision.', 'Победителей держать как controls.', 'Слабые варианты удалять без превращения шума в знания.'],
    next: 'Добавить template для Content Experiment note.'
  },
  'research-workflow': {
    what: 'Research workflow значит: claims получают источники до того, как становятся рабочим знанием.',
    why: 'Ссылка должна подтверждать, исправлять или ограничивать вывод. Иначе это декорация.',
    how: ['Отделять extracted claim от verified conclusion.', 'Предпочитать official docs и primary repositories.', 'Писать, что именно источник изменил в выводе.'],
    next: 'Добавить поле `source_changed_what` в final atom schema.'
  },
  misc: {
    what: 'Прочие сигналы - материалы, которые пока не сложились в сильный reusable cluster.',
    why: 'Отдельный misc-кластер защищает сильные знания от слабого шума.',
    how: ['Проверить вручную.', 'Повышать до знания только повторяющиеся или ценные идеи.', 'Низкий сигнал отправлять в forget/archive.'],
    next: 'Вручную разобрать misc-сигналы: promote или forget.'
  }
}

function compact(value, limit = 1200) {
  return String(value || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function slugify(value) {
  return String(value || 'note')
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'note'
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

// Content fingerprint = stable hash of a cluster's sorted source refs. Same
// inputs -> same fingerprint -> same filename, so re-runs are idempotent and
// exact-duplicate clusters are not rewritten (see write loop skip).
// ponytail: exact-dup only via source-ref hash; near-duplicate (paraphrase)
// dedup needs embeddings — wire fastembed/Ollama here if dup clusters appear.
function fingerprint(cluster) {
  const refs = cluster.records.map(record => String(record.source_ref || "")).sort()
  const key = [cluster.id || "", cluster.part || 1, ...refs].join(" ")
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 10)
}

function extractUrls(text) {
  const raw = String(text || '')
  const explicit = raw.match(/\bhttps?:\/\/[^\s)]+/g) || []
  const bareGithub = [...raw.matchAll(/\bgithub\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)]
    .map(match => `https://${match[0]}`)
  return uniq([...explicit, ...bareGithub])
    .map(url => url.replace(/[.,;]+$/, ''))
    .filter(isPublicHttpUrl)
    .slice(0, 8)
}

function bullets(text, max = 8) {
  const out = []
  const seen = new Set()
  for (const part of String(text || '').split(/\n|[•*-]\s+|(?<=[.!?])\s+/)) {
    const line = compact(part, 190)
    if (line.length < 32) continue
    if (/^(video keyframe ocr|video transcript|img_|temp_image|follow|subscribe|save this)/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function classify(text) {
  const hit = clusterRules.find(rule => rule.re.test(text))
  return hit ? hit.id : 'misc'
}

function clusterTitle(id) {
  return clusterRules.find(rule => rule.id === id)?.title || 'Miscellaneous knowledge signals'
}

function clusterTitleRu(id) {
  const map = {
    'agent-systems': 'Агентные системы и переиспользуемые возможности',
    'knowledge-memory': 'Память знаний, vault и циклы синтеза',
    'security-review': 'Безопасность, ревью и границы доверия',
    'engineering-ops': 'Инженерные операции и воспроизводимая доставка',
    'design-frontend': 'Дизайн-системы и качество фронтенда',
    'tool-radar': 'Радар инструментов и выбор open-source',
    'startup-strategy': 'Стратегия стартапа и founder-led рост',
    'content-growth': 'Контентные эксперименты и петли роста',
    'research-workflow': 'Исследовательский workflow и проверка источников',
    misc: 'Прочие сигналы знаний'
  }
  return map[id] || map.misc
}

function publicSources(text) {
  const explicit = extractUrls(text).map(url => ({ name: url.includes('github.com') ? 'GitHub source' : 'Source link', url }))
  const hinted = sourceHints
    .filter(source => source.re.test(text))
    .map(({ name, url }) => ({ name, url }))
  const byUrl = new Map()
  for (const source of [...explicit, ...hinted]) {
    if (isPublicHttpUrl(source.url)) byUrl.set(source.url, source)
  }
  return [...byUrl.values()].slice(0, 10)
}

function githubRepoFromUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname.replace(/^www\./, '') !== 'github.com') return null
  const [, owner, repo] = parsed.pathname.split('/')
  if (!owner || !repo) return null
  const cleanOwner = owner.replace(/^Leonx1nx$/i, 'Leonxlnx')
  const cleanRepo = repo.replace(/\.git$/i, '')
  if (cleanRepo.endsWith('-')) return null
  return { owner: cleanOwner, repo: cleanRepo, url: `https://github.com/${cleanOwner}/${cleanRepo}` }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mnemazine' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchText(url, limit = 40000) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mnemazine' } })
    if (!res.ok) return ''
    return (await res.text()).slice(0, limit)
  } catch {
    return ''
  }
}

function looksLikeCode(text) {
  // JS-heavy pages (YouTube et al) leak `(function() {window.ytplayer={};` and
  // `ytcfg.set({"KEY":...})` into "external facts". Prose has no braces/arrows
  // and is mostly letters and spaces.
  const value = String(text || '')
  if (/[{}]|=>|\);|\w+\.\w+\(|^\(function/.test(value)) return true
  const letters = (value.match(/[\p{L}\s.,;:!?()'"-]/gu) || []).length
  return letters / Math.max(1, value.length) < 0.85
}

function readmePoints(readme, max = 6) {
  const points = []
  for (const line of stripHtmlText(readme).split('\n')) {
    const clean = compact(line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, ''), 220)
    if (clean.length < 32) continue
    if (/^[,.;:]/.test(clean) || /^https?:\/\//i.test(clean)) continue
    if (/^(install|usage|license|contributing|table of contents|badges?)$/i.test(clean)) continue
    if (/^!\[|^<img|^\[!?\[|^window\.|^document\.|^function\s/i.test(line.trim())) continue
    if (/\b(src|href|alt|title)=["'][^"']*["']/i.test(clean)) continue
    if (/https?:\/\/\S+\.(?:svg|png|jpe?g|gif|webp)(?:\?\S*)?$/i.test(clean)) continue
    if (/<[a-z][\s\S]*>/i.test(clean)) continue
    if (looksLikeCode(clean)) continue
    points.push(clean)
    if (points.length >= max) break
  }
  return points
}

function latinCount(text) {
  return (String(text || '').match(/[A-Za-z]/g) || []).length
}

function cyrillicCount(text) {
  return (String(text || '').match(/[А-Яа-яЁё]/g) || []).length
}

function russianSourceSignal(text, fallback = 'проверяемый сигнал первоисточника') {
  const clean = compact(text, 180)
  if (!clean) return fallback
  const low = clean.toLowerCase()
  if (/critical vulnerab|vulnerab/.test(low)) return 'заявленный security-риск marketplace skills'
  if (/secure|validated|hardened|confidence/.test(low)) return 'позиционирование как проверенный каталог skills'
  if (/registry|library|catalog/.test(low)) return 'каталог skills и reusable capabilities'
  if (/agent|skill|claude|cursor|copilot|antigravity/.test(low)) return 'поддержка skills для AI coding agents и IDE'
  if (latinCount(clean) > Math.max(40, cyrillicCount(clean) * 2)) return fallback
  return clean
}

function htmlDescription(html) {
  const raw = String(html || '')
  const hit = raw.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
    raw.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
  return hit ? compact(decodeEntities(hit[1]), 260) : ''
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function stripHtmlText(text) {
  return decodeEntities(String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<[^>]+>/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

async function fetchRawReadme(repoRef, preferredBranch = '') {
  const branches = [preferredBranch, 'main', 'master', 'dev', 'trunk'].filter(Boolean)
  const names = ['README.md', 'readme.md', 'README.MD']
  for (const branch of branches) {
    for (const name of names) {
      const url = `https://raw.githubusercontent.com/${repoRef.owner}/${repoRef.repo}/${branch}/${name}`
      const text = await fetchText(url)
      if (text && !/^404:/i.test(text)) return { text, url }
    }
  }
  return { text: '', url: `https://github.com/${repoRef.owner}/${repoRef.repo}#readme` }
}

async function enrichClusterFromGithub(cluster, sources) {
  const repoRef = sources.map(source => githubRepoFromUrl(source.url)).find(Boolean)
  if (!repoRef) return null
  let api = await fetchJson(`https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}`)
  const readmeMeta = api?.html_url ? await fetchJson(`https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}/readme`) : null
  const rawReadme = readmeMeta?.download_url
    ? { text: await fetchText(readmeMeta.download_url), url: readmeMeta.download_url }
    : await fetchRawReadme(repoRef, api?.default_branch || '')
  const repoHtml = api?.html_url ? '' : await fetchText(repoRef.url, 60000)
  if (!api?.html_url) {
    if (!rawReadme.text && !repoHtml) return null
    api = {
      full_name: `${repoRef.owner}/${repoRef.repo}`,
      html_url: repoRef.url,
      description: htmlDescription(repoHtml) || readmePoints(rawReadme.text, 1)[0] || 'официальный GitHub-репозиторий',
      stargazers_count: 'unknown',
      forks_count: 'unknown',
      open_issues_count: 'unknown',
      license: null,
      language: 'unknown',
      pushed_at: '',
      default_branch: 'unknown'
    }
  }
  const readmeUrl = rawReadme.url
  const readme = rawReadme.text
  const release = await fetchJson(`https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}/releases/latest`)
  const points = readmePoints(readme)
  const description = russianSourceSignal(api.description, 'англоязычное описание GitHub; точная формулировка сохранена в primary source')
  const pointSignals = points.map(point => russianSourceSignal(point, 'README-сигнал требует ручной сверки')).filter(Boolean)
  const license = api.license?.spdx_id || api.license?.name || 'лицензия неизвестна'
  const pushed = api.pushed_at ? api.pushed_at.slice(0, 10) : 'unknown'
  const releaseLine = release?.tag_name ? `${release.tag_name} (${String(release.published_at || '').slice(0, 10) || 'дата неизвестна'})` : 'GitHub API не вернул latest release'
  const addedFacts = [
    `${api.full_name}: ${description}.`,
    `Метаданные GitHub: ${api.stargazers_count} звезд, ${api.forks_count} форков, ${api.open_issues_count} открытых issues, лицензия ${license}, основной язык ${api.language || 'unknown'}.`,
    `Свежесть репозитория: основная ветка ${api.default_branch || 'unknown'}, последний push ${pushed}, последний release ${releaseLine}.`,
    ...pointSignals.slice(0, 5).map(point => `Сигнал README: ${point}.`)
  ]
  const addedSources = [
    api.html_url,
    readmeUrl,
    release?.html_url
  ].filter(Boolean)
  const enriched = [
    `Расширение по официальному GitHub для ${api.full_name}.`,
    `Описание: ${description}.`,
    `Метаданные: ${api.stargazers_count} звезд, ${api.forks_count} форков, ${api.open_issues_count} открытых issues, ${license}, язык ${api.language || 'unknown'}, последний push ${pushed}.`,
    `Последний release: ${releaseLine}.`,
    pointSignals.length ? `Из README извлечены рабочие сигналы:\n${pointSignals.map(point => `- ${point}`).join('\n')}` : 'README не дал устойчивых feature-пунктов без ручной проверки.',
    `Локальные source refs: ${cluster.records.map(r => r.source_ref).join(', ')}.`
  ].join('\n\n')
  return { enriched, addedSources, addedFacts, github: { api, readmeUrl, release, points } }
}

async function enrichClusterFromSources(cluster, sources) {
  const picked = sources.filter(source => isPublicHttpUrl(source.url)).slice(0, 4)
  if (!picked.length) return null
  const addedSources = []
  const addedFacts = []
  const sections = []
  for (const source of picked) {
    const text = await fetchText(source.url, 40000)
    if (!text) continue
    const desc = htmlDescription(text) || readmePoints(text, 1)[0] || `${source.name} is reachable at ${source.url}.`
    const points = readmePoints(text, 3)
    addedSources.push(source.url)
    addedFacts.push(`${source.name}: ${desc}`)
    for (const point of points) addedFacts.push(`${source.name}: сигнал источника - ${point}`)
    sections.push(`${source.name} (${source.url})\n${[desc, ...points].filter(Boolean).map(p => `- ${p}`).join('\n')}`)
    if (addedFacts.length >= 6) break
  }
  if (!addedSources.length || addedFacts.length < MIN_ADDED_FACTS) return null
  const template = topicTemplates[cluster.id] || topicTemplates.misc
  const enriched = [
    `Детерминированное расширение источниками для ${clusterTitleRu(cluster.id)}.`,
    template.what,
    template.why,
    sections.join('\n\n'),
    `Локальные source refs: ${cluster.records.map(r => r.source_ref).join(', ')}.`
  ].join('\n\n')
  return { enriched, addedSources, addedFacts, sourceFacts: { sources: addedSources, facts: addedFacts } }
}

function atomsFromGithub(part, sources) {
  const github = part.enrichment?.github
  if (!github?.api) return []
  const api = github.api
  const repo = api.full_name
  const sourceUrls = [api.html_url, github.readmeUrl, github.release?.html_url].filter(Boolean)
  const points = (github.points || []).map(point => russianSourceSignal(point, 'README-сигнал требует ручной сверки')).filter(Boolean)
  const license = api.license?.spdx_id || api.license?.name || 'unknown license'
  const releaseLine = github.release?.tag_name || 'no latest release returned'
  const description = russianSourceSignal(api.description, 'англоязычное описание GitHub; точная формулировка в primary source')
  return [
    {
      title: `${repo}: проверенная карточка инструмента`,
      source_refs: part.records.map(record => record.source_ref).filter(Boolean),
      what: `${repo} - официальный GitHub-репозиторий инструмента из inbox. Описание: ${description}. GitHub показывает: ${api.stargazers_count} stars, ${api.forks_count} forks, ${api.open_issues_count} open issues, лицензия ${license}, основной язык ${api.language || 'unknown'}, последний push ${api.pushed_at ? api.pushed_at.slice(0, 10) : 'unknown'}.`,
      why: 'Это превращает скриншот или карточку со звездами в проверяемую запись: есть primary source, дата свежести, лицензия и базовый риск.',
      how: ['Сначала смотреть метаданные: лицензия, свежесть, stars, forks, issues.', 'Перед установкой открыть README и issues, скриншот считать только подсказкой.', 'Решение фиксировать отдельно: установить сейчас, протестировать позже или забыть.'],
      sources: sourceUrls,
      next: `Прочитать README ${repo} и решить, нужен ли он в реестре возможностей.`
    },
    {
      title: `${repo}: что реально обещает README`,
      source_refs: part.records.map(record => record.source_ref).filter(Boolean),
      what: points.length ? `README дает проверяемые сигналы: ${points.slice(0, 4).join('; ')}.` : `${repo} имеет официальный README, но Mnemazine не нашла в нем устойчивые продуктовые тезисы без ручной проверки.`,
      why: 'README ближе к рабочей правде, чем подпись на скриншоте. Он показывает, что авторы реально поддерживают и документируют.',
      how: points.slice(0, 5).map(point => `Проверить по README: ${point}`),
      sources: sourceUrls,
      next: `Связать возможности ${repo} с одним конкретным рабочим сценарием до установки.`
    },
    {
      title: `${repo}: риск эксплуатации и поддержки`,
      source_refs: part.records.map(record => record.source_ref).filter(Boolean),
      what: `Поверхность риска: ${api.open_issues_count} open issues, последний release ${releaseLine}, последний push ${api.pushed_at ? api.pushed_at.slice(0, 10) : 'unknown'}, лицензия ${license}.`,
      why: 'Популярный репозиторий все равно может быть плохой зависимостью, если релизы, лицензия или issue-профиль не подходят под workflow.',
      how: ['Проверить issues на security, потерю данных и ошибки установки.', 'Сначала гонять в одноразовом workspace, не добавлять сразу в глобальные правила агента.', 'Если это станет Skill/MCP/plugin, записать source ledger и usage ledger.'],
      sources: sourceUrls,
      next: `Запустить маленький локальный пробный запуск для ${repo} только при понятной пригодности к рабочему сценарию.`
    },
    {
      title: `${repo}: решение для Mnemazine`,
      source_refs: part.records.map(record => record.source_ref).filter(Boolean),
      what: `Этот атом связывает локальный захват с primary GitHub evidence по ${repo}. Это не команда установить, а кандидат на разбор.`,
      why: 'Полезная память - не "увидел репозиторий", а решение: что инструмент делает, подходит ли он, какой риск остается и что делать дальше.',
      how: ['Хранить репозиторий как кандидата в рабочие возможности, не как инструкцию к установке.', 'Если принять, зеркалировать docs/skill metadata и логировать usage.', 'Если отклонить, записать причину, чтобы репозиторий не возвращался шумом.'],
      sources: sourceUrls,
      next: `Добавить ${repo} в очередь разбора возможностей с одним критерием: принять или отклонить.`
    }
  ]
}

function atomsFromSources(part, sources) {
  const template = topicTemplatesRu[part.id] || topicTemplatesRu.misc
  const facts = part.enrichment?.addedFacts || []
  const sourceUrls = sources.map(source => source.url).filter(isPublicHttpUrl)
  const how = Array.isArray(template.how) ? template.how : String(template.how || '').split('\n').map(line => line.replace(/^-\s*/, '').trim()).filter(Boolean)
  return [
    {
      title: `${clusterTitleRu(part.id)}: проверенный рабочий паттерн`,
      source_refs: part.records.map(record => record.source_ref).filter(Boolean),
      what: `${template.what} Источники добавили проверяемые опорные факты: ${facts.slice(0, 2).join(' ')}`,
      why: template.why,
      how: [...how, ...facts.slice(2, 4).map(fact => `Проверить по источнику: ${fact}`)].slice(0, 5),
      sources: sourceUrls,
      next: template.next
    }
  ]
}

function atomsFromDeterministic(part, sources) {
  if (part.enrichment?.kind === 'github') return atomsFromGithub(part, sources)
  return atomsFromSources(part, sources)
}

function recordTitle(record) {
  const url = extractUrls(record.text)[0]
  if (url) return url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').slice(0, 90)
  const title = String(record.text || '')
    .split(/\n|[.!?]\s+/)
    .map(line => compact(line, 120))
    .find(line => line.length >= 18 && !/^(video keyframe ocr|video transcript|img_|temp_image|сообщество подписки|рекомендации)/i.test(line))
  return title || record.source_ref
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function topicSignals(cluster, sources) {
  const hosts = uniq(sources.map(source => hostOf(source.url)).filter(Boolean)).slice(0, 6)
  const sourceLine = hosts.length ? `Найдены публичные источники: ${hosts.join(', ')}.` : 'Стабильный публичный URL в кластере не найден.'
  const map = {
    'agent-systems': ['Повторяются агентные сигналы: Skills, MCP, память, browser tools, роли ревью и harness rules.', sourceLine],
    'knowledge-memory': ['Повторяются сигналы памяти: структура vault, поиск связей, weekly synthesis, decisions, beliefs и active indexes.', sourceLine],
    'security-review': ['Повторяются сигналы доверия: prompt injection, секреты, permissions, review gates и accessibility checks.', sourceLine],
    'engineering-ops': ['Повторяются инженерные сигналы: воспроизводимые окружения, IaC, worktrees, observability, release checks и secret injection.', sourceLine],
    'design-frontend': ['Повторяются UI-сигналы: DESIGN.md, taste rules, frontend structure, Playwright/browser checks и WCAG constraints.', sourceLine],
    'tool-radar': ['Повторяются tool-radar сигналы: GitHub repos, self-hosting, AI tools и open-source alternatives.', sourceLine],
    'startup-strategy': ['Повторяются startup-сигналы: узкая ниша, скорость внедрения, прямой контакт с клиентом, founder-led доверие и ручной сервис до scale.', sourceLine],
    'content-growth': ['Повторяются growth-сигналы: ad variants, hooks, CTA, short-form generation, metrics и winner/loser loops.', sourceLine],
    'research-workflow': ['Повторяются research-сигналы: сбор источников, проверка claims, evidence, drafting и revision.', sourceLine],
    misc: ['Слабые misc-сигналы отделены от сильных knowledge atoms.', sourceLine]
  }
  return map[cluster.id] || map.misc
}

async function listRecords() {
  const records = []
  for (const entry of await fs.readdir(EXTRACTS, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(EXTRACTS, entry.name)
    let record
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (err) {
      console.error(`[synthesize] skipping corrupt extract cache ${entry.name}: ${err.message}`)
      continue
    }
    if (record.status !== 'extracted_for_note' || !record.text_path) continue
    if (SOURCE_REF_FILTER.size && !SOURCE_REF_FILTER.has(record.source_ref)) continue
    const textFile = path.join(EXTRACTS, record.text_path)
    const text = await fs.readFile(textFile, 'utf8').catch(() => '')
    if (compact(text, 100).length < 40) continue
    records.push({ ...record, text })
  }
  return records
}

function chunks(values, size) {
  const out = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

function makeNote(cluster) {
  const text = cluster.records.map(record => record.text).join('\n\n')
  const baseTitle = clusterTitleRu(cluster.id)
  const title = cluster.partCount > 1 ? `${baseTitle} ${cluster.part}/${cluster.partCount}` : baseTitle
  const template = topicTemplatesRu[cluster.id] || topicTemplatesRu.misc
  const sources = publicSources(text)
  const signals = topicSignals(cluster, sources)
  const sourceRefs = cluster.records.map(record => `- ${record.source_ref}`)
  const sourceLines = sources.length
    ? sources.map(source => `- ${source.name}: ${source.url}`)
    : ['- Публичный источник не найден в extraction; перед применением нужна внешняя проверка.']
  const sourceStatus = sources.length ? 'local synthesis with public source expansion' : 'local synthesis; external verification required'
  const localVerdict = verifyLocal(sources.map(s => s.url))
  const how = Array.isArray(template.how) ? template.how.map(item => `- ${item}`).join('\n') : template.how
  const risk = sources.length
    ? 'Публичные ссылки найдены или добавлены по source hints, но перед adoption claims все равно надо проверить под конкретный проект.'
    : 'Публичного источника в extraction не было; это локальный memory atom, а не внешне подтвержденный claim.'
  return `---
title: "${title.replace(/"/g, '\\"')}"
type: "synthesis"
subject: world
source_type: "synthesis-cluster"
source: "session:${SESSION}/${cluster.id}"
source_ref: "session:${SESSION}/${cluster.id}"
verified: ${specVerified(localVerdict.status)}
verification_status: "${localVerdict.status}"
verification: "${sourceStatus}"
status: "draft"
cluster_size: ${cluster.records.length}
cluster_fingerprint: "${fingerprint(cluster)}"
---

# ${title}

## Что это

${template.what}

Ключевые сигналы сессии:
${signals.map(signal => `- ${signal}`).join('\n')}

## Зачем это нужно

${template.why}

Заметка сжимает ${cluster.records.length} исходных элементов в переиспользуемое знание. Source-level extraction остается в \`.mnemazine/cache/extracted\`.

## Как использовать

${how}

## Источники

Локальные source refs:
${sourceRefs.slice(0, 30).join('\n')}
${sourceRefs.length > 30 ? `- ... еще ${sourceRefs.length - 30} source refs сохранены в extraction cache` : ''}

Публичные источники:
${sourceLines.join('\n')}

## 🎯 Как это поможет мне

- ${template.next}
- Тема: ${clusterTitleRu(cluster.id)} — черновик собран, но требует проверки перед применением.

## Достоверность

- **Автоматический fact-check не запускался.** Это unverified synthesis cluster (\`status: draft\`). URL из extraction или topic hints - указатели, не подтверждение конкретного claim.
- Повышать до \`status: final\` только после проверки человеком или verify gate по primary sources.
- Уверенность: низкая до проверки. Даты, цены, stars, security claims и release status считать неподтвержденными.
- Риск: ${risk}

## Связанные заметки

- [[Mnemazine Protocol]]
- [[${clusterTitleRu(cluster.id)}]]

## Следующее действие

- ${template.next}
`
}

const ATOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['atoms'],
  properties: {
    atoms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'what', 'why', 'how', 'next', 'sources', 'source_refs'],
        properties: {
          title: { type: 'string' },
          what: { type: 'string' },
          why: { type: 'string' },
          how: { type: 'array', items: { type: 'string' } },
          next: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          source_refs: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

// Owner projects come from the vault (99 Система/_ПРОЕКТЫ.md), never hardcoded —
// the spec gate rejects a "как это поможет мне" block that names no real project.
let OWNER_PROJECTS = null
function ownerProjects() {
  if (OWNER_PROJECTS) return OWNER_PROJECTS
  try {
    const text = readFileSync(path.join(VAULT, '99 Система', '_ПРОЕКТЫ.md'), 'utf8')
    OWNER_PROJECTS = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]).filter(Boolean)
  } catch { OWNER_PROJECTS = [] }
  return OWNER_PROJECTS
}

function atomPrompt(cluster, sources, materialOverride) {
  // When enrichment ran, atomize the EXPANDED knowledge; else the raw capture.
  //
  // Врезка Метиды стоит ТОЛЬКО на сырой ветке. Числа, по которым так решено, ниже - чтобы
  // следующая сессия не переоткрывала вопрос гипотезой.
  //
  // Прежнее основание "сырая ветка в дефолте недостижима, ее запирает строгий гейт STRICT_ENRICH
  // в processPart (ищи строку `strict enrichment failed for cluster`)"
  // проверено и верно лишь для дефолта РЕПОЗИТОРИЯ. Живая раскладка владельца
  // (.mnemazine/config.local.sh, его читают npm start и scripts/mnemazine-desktop-protocol.sh)
  // ставит MNEMAZINE_STRICT_ENRICH=0, и тогда [замер] выражение STRICT_ENRICH дает false.
  // Значит при неудачном обогащении сюда приходит СЫРЬЕ, тот же класс входа, что у enrichCluster,
  // и режется оно так же вслепую.
  //
  // [замер] на живом кеше дома (.mnemazine/cache/extracted, 28 частей кластеров, срез 2026-08-31):
  // сырой вход медиана 21464 Б, p90 30760 Б, максимум 31994 Б. Порог профиля balanced - 512
  // символов, вход берет его с запасом. 4 части из 28 перебивают слепой рез MAX_MATERIAL_CHARS и
  // теряют хвост в 1152, 2542, 3196 и 4223 символа. Свертка на 9 частях из 28 дает выигрыш 50.2-52.8%,
  // на остальных 19 отказывается и возвращает вход байт в байт (доктрина 4). Метки SOURCE_REF:
  // свертка не теряет ни одной: 543 из 560 переживают И свертку, И сегодняшний слепой рез, разница
  // ноль. Выход свертки на всех 9 частях не превышает 11617 символов, поэтому хвостовой .slice(...)
  // маркер восстановления никогда не разрезает.
  //
  // Ветка materialOverride НЕ тронута, и теперь это ЗАМЕР, а не отсутствие замера. Прошлая
  // сессия числа не получила: вызов не укладывался в собственный потолок ENRICH_TIMEOUT_MS -
  // SIGKILL бил по обертке npm, внутренний бинарь оставался сиротой с открытыми трубами, и
  // событие close у runProc не наступало вовсе [замер: 26 минут живого вызова при потолке 7].
  // Потолок починен, и живой прогон стал возможен.
  //
  // [замер, три живых прогона обогащения на кластере agent-systems, маршрут llm] обогащенный
  // материал выходит 5154, 7056 и 5939 знаков (8348, 11636 и 9766 байт). Свертка на нем дает
  // РОВНО НОЛЬ: 0.0% и ни одного примененного шага на всех трех профилях (coding, balanced,
  // aggressive), вход возвращается байт в байт по доктрине 4. Причина видна в самом материале:
  // это СПЛОШНАЯ ПРОЗА, написанная моделью, - ни таблиц, ни повторяющихся блоков, ни журнальных
  // строк, то есть ничего, что свертка умеет сложить. Врезка тут была бы мертвым шагом.
  // Слепой рез при этом не теряет НИЧЕГО: потолок 28000 знаков не достигается ни одним из трех
  // прогонов (запас втрое), тогда как на сырой ветке рез срезал хвосты у 4 частей из 28.
  // Переоткрывать только с новым замером на материале другой формы.
  //
  // ГРАНИЦА ЗАМЕРА, чтобы его не выдали за большее. Ветка materialOverride достижима ТОЛЬКО
  // маршрутом llm: при детерминированном обогащении (github, sources) атомы строит
  // atomsFromDeterministic, и atomPrompt не зовется вовсе. Три точки сняты на одном кластере.
  //
  // Откат (обратная замена одной строки):
  //   : cluster.records.map(r => `SOURCE_REF: ${r.source_ref}\n${compact(r.text, MAX_RECORD_CHARS)}`).join('\n---\n').slice(0, MAX_MATERIAL_CHARS)
  const text = materialOverride
    ? String(materialOverride).slice(0, Math.max(28000, MAX_MATERIAL_CHARS))
    : squeezeMetiz(
      cluster.records.map(r => `SOURCE_REF: ${r.source_ref}\n${compact(r.text, MAX_RECORD_CHARS)}`).join('\n---\n'),
      { label: `atomize-raw:${cluster.id}`, budgetChars: MAX_MATERIAL_CHARS }
    ).text.slice(0, MAX_MATERIAL_CHARS)
  const urls = sources.map(s => s.url).join(', ') || 'none detected'
  const refs = cluster.records.map(r => r.source_ref).filter(Boolean).join(', ')
  return `You are Mnemazine's atomization agent. Split the enriched research material below into FOCUSED, atomic knowledge notes — one idea per atom, up to ${MAX_ATOMS}. Do NOT merge unrelated ideas; do NOT invent facts not present in the material. Each atom: a precise title, a one-paragraph "what", a one-paragraph "why it matters", 2-5 concrete "how to use" bullets, one "next action", the subset of source URLs that support it (from: ${urls}; [] only if truly local/private), and the subset of local source_refs that support this exact atom (from: ${refs}; never include an unrelated source_ref just because it is in the same cluster).

Пиши значения JSON на русском языке. Return ONLY JSON matching the schema.

Заголовок атома (title) — живой русский без канцелярита: запрещены «является/являются», «данный», «осуществляет», «представляет собой». Пиши «X — Y», а не «X является Y»: заголовок уходит в имя файла и в ссылки, канцелярит оттуда расползается по всей базе.

Поле "next" (следующее действие) обязано НАЧИНАТЬСЯ с имени проекта владельца, которому этот атом полезен, — дословно одним из списка: ${ownerProjects().join(' · ') || 'Саморазвитие/инструментарий'}. Если ни один проект по теме не подходит, пиши «Саморазвитие/инструментарий». Формат: «&lt;Проект&gt;: &lt;одно конкретное действие&gt;». Проект не выдумывать и не переименовывать.

${fenceUntrusted('MATERIAL', text)}`
}

async function atomizeCluster(cluster, sources, materialOverride) {
  const result = await llmJson(atomPrompt(cluster, sources, materialOverride), ATOM_SCHEMA, {
    provider: ATOMIZER_PROVIDER,
    label: `atomize:${cluster.id}`
  })
  const atoms = Array.isArray(result?.atoms) ? result.atoms : []
  return atoms.filter(a => a && a.title && a.what).slice(0, MAX_ATOMS)
}

// --- Enrichment (knowledge EXPANSION, README "research", G/B) ---
// A web-capable LLM agent researches the captured material and grows it "as much
// as truly needed": pulls primary sources, current facts/versions, practitioner
// experience — each added fact tied to a fetched URL (anti-hallucination). Output
// feeds atomize, so atoms are built from EXPANDED knowledge, not just the capture.
const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enriched', 'sources', 'added_facts'],
  properties: {
    enriched: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    added_facts: { type: 'array', items: { type: 'string' } }
  }
}

function enrichPrompt(text, sources) {
  const urls = sources.map(s => s.url).join(', ') || 'none detected'
  return `You are Mnemazine's research-enrich agent. The MATERIAL below is a SEED, not the final knowledge. Research it with available tools (web search, web fetch, and any configured MCP web tools) and EXPAND it as much as is genuinely useful — no padding. Pull: the primary source, current facts/numbers/versions, concrete examples, and real practitioner experience (issues, pros/cons, gotchas) with thread/issue URLs. Anti-hallucination: every added fact MUST trace to a fetched URL; if unconfirmed, say so, do not strengthen it. Keep it tight and factual.

Known source hints: ${urls}.

Produce: "enriched" = the expanded knowledge as clean Russian prose, "sources" = all source URLs used, "added_facts" = short Russian bullet list of what you added beyond the seed.

${fenceUntrusted('MATERIAL', text)}`
}

async function enrichCluster(cluster, sources) {
  // Врезка Метиды (см. scripts/mnemazine-metiz.mjs): раньше материал резался вслепую ДО того, как
  // уйти в MATERIAL промта (см. комментарий у MAX_RECORD_CHARS выше про "atoms only ever covered
  // the intro") - теперь Метида видит текст целиком и решает, что оставить в границах того же
  // потолка символов; budgetChars гарантирует, что примененный результат никогда не превысит
  // MAX_MATERIAL_CHARS, а внешний .slice(...) остается защитой на случай, если сжать не вышло
  // (fail-open дома squeezeMetiz - без Метиды текст режется ровно как раньше, той же строкой).
  const text = squeezeMetiz(
    cluster.records.map(r => compact(r.text, Math.max(6000, MAX_RECORD_CHARS))).join('\n---\n'),
    { label: `enrich:${cluster.id}`, budgetChars: MAX_MATERIAL_CHARS }
  ).text.slice(0, MAX_MATERIAL_CHARS)
  const res = await llmJson(enrichPrompt(text, sources), ENRICH_SCHEMA, {
    provider: VERIFIER_PROVIDER,
    tools: ['WebSearch', 'WebFetch'],
    timeoutMs: ENRICH_TIMEOUT_MS,
    label: `enrich:${cluster.id}`
  })
  const enriched = typeof res?.enriched === 'string' ? res.enriched.trim() : ''
  const addedSources = Array.isArray(res?.sources) ? res.sources.filter(isPublicHttpUrl) : []
  const addedFacts = Array.isArray(res?.added_facts) ? res.added_facts.filter(Boolean) : []
  return { enriched, addedSources, addedFacts }
}

function atomFingerprint(atom, clusterId = '') {
  // clusterId scopes the hash so identical titles in different clusters (common
  // for sourceless low-confidence atoms) get distinct filenames, not silent skips.
  const key = [clusterId, atom.title, ...(atom.sources || []).slice().sort()].join('|')
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)
}

function words(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter(word => word.length >= 4)
}

function localSourceRefsForAtom(cluster, atom) {
  const valid = new Set(cluster.records.map(record => record.source_ref).filter(Boolean))
  const explicit = Array.isArray(atom.source_refs)
    ? atom.source_refs.filter(ref => valid.has(ref))
    : []
  if (explicit.length) return [...new Set(explicit)]

  const atomText = `${atom.title || ''}\n${atom.what || ''}\n${(atom.sources || []).join('\n')}`.toLowerCase()
  const tokens = new Set(words(atomText))
  const scored = cluster.records
    .map(record => {
      const text = String(record.text || '').toLowerCase()
      let score = 0
      for (const source of atom.sources || []) {
        const url = String(source || '').toLowerCase()
        if (url && text.includes(url.replace(/^https?:\/\//, '').replace(/^www\./, ''))) score += 8
        try {
          const parsed = new URL(url)
          const pathBits = parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/')
          if (pathBits && text.includes(pathBits.toLowerCase())) score += 6
          if (parsed.hostname && text.includes(parsed.hostname.replace(/^www\./, ''))) score += 3
        } catch {}
      }
      for (const token of tokens) if (text.includes(token)) score += 1
      return { ref: record.source_ref, score }
    })
    .filter(item => item.ref && item.score > 0)
    .sort((a, b) => b.score - a.score)
  const best = scored[0]?.score || 0
  return scored.filter(item => item.score === best).map(item => item.ref)
}

// NOTE-SPEC enum is the single truth for `verified:` (SPEC_VERIFIED). Deep verify
// speaks verified|assumed|unknown, so map it here instead of writing a boolean the
// spec gate rejects.
function specVerified(status) {
  const map = { verified: SPEC_VERIFIED[0], assumed: SPEC_VERIFIED[2], unknown: SPEC_VERIFIED[5] }
  return map[status] || SPEC_VERIFIED[5]
}

function makeAtomNote(cluster, atom, verdict) {
  const how = (atom.how || []).filter(Boolean).map(h => `- ${compact(h, 240)}`).join('\n') || '- Проверить и применить в контексте.'
  const localRefs = localSourceRefsForAtom(cluster, atom)
  const sourceRefs = (localRefs.length ? localRefs : cluster.records.map(record => record.source_ref))
    .filter(Boolean)
    .map(ref => `- ${ref}`)
    .join('\n')
  const addedFacts = (cluster.enrichment?.addedFacts || []).map(f => `- ${compact(f, 300)}`).join('\n') || '- Внешние факты не записаны.'
  const srcs = (atom.sources || []).filter(isPublicHttpUrl)
  const sourceLines = srcs.length
    ? srcs.map(u => `- ${hostOf(u) || 'Источник'}: ${u}`).join('\n')
    : '- Публичный источник не найден; перед применением нужна внешняя проверка.'
  const fp = atomFingerprint(atom, cluster.id)
  const v = verdict || { status: 'unknown', note: '' }
  const isVerified = v.status === 'verified'
  return `---
title: "${String(atom.title).replace(/"/g, '\\"').slice(0, 120)}"
type: "synthesis"
subject: world
source_type: "synthesis-atom"
source: "session:${SESSION}/${cluster.id}#${fp}"
source_ref: "session:${SESSION}/${cluster.id}#${fp}"
verified: ${specVerified(v.status)}
verification_status: "${v.status}"
verification: "llm-atomized; ${String(v.note || 'sources unverified').replace(/"/g, "'")}"
status: "${isVerified ? 'final' : 'draft'}"
enrichment: "${cluster.enrichment?.ok ? 'external-research' : 'missing'}"
cluster_id: "${cluster.id}"
cluster_fingerprint: "${fp}"
---

# ${compact(atom.title, 120)}

## Что это

${compact(atom.what, 1200)}

## Зачем это нужно

${compact(atom.why, 1200)}

## Как использовать

${how}

## Источники

Локальные source refs:
${sourceRefs}

Публичные источники:
${sourceLines}

## Расширение знания

Факты, добавленные до атомизации:
${addedFacts}

## 🎯 Как это поможет мне

- ${compact(atom.next, 240) || 'Применить в ближайшей задаче по теме кластера.'}
- Тема: ${clusterTitleRu(cluster.id)} — смотреть сюда, когда всплывет этот вопрос.

## Достоверность

- Статус проверки: **${v.status}**${v.note ? ` (${v.note})` : ''}.
${isVerified
  ? `- Утверждение сверено с указанными источниками.${v.evidence ? ` Подтверждение: ${compact(v.evidence, 300)}` : ''}`
  : '- **Claim-level fact-check не подтвердил это.** URL - указатели, не доказательство. Статус `verified` допустим только после deep verify.'}
- ${v.status === 'unknown' ? 'Нет source URL: это локальный memory atom, а не внешне подтвержденный claim.' : 'Уверенность: средняя, пока человек или deep verify не подтвердит вывод.'}

## Связанные заметки

- [[Mnemazine Protocol]]
- [[${clusterTitleRu(cluster.id)}]]

## Следующее действие

- ${compact(atom.next, 240) || 'Проверить и применить по контексту.'}
`
}

await fs.mkdir(path.join(VAULT, '01 Concepts'), { recursive: true })
// One runnable check for the source-scrape junk filter: real prose survives,
// leaked page JS does not. Run: node scripts/mnemazine-synthesize.mjs --selftest
if (argv.includes('--selftest')) {
  const junk = [
    '(function() {window.ytplayer={};',
    'ytcfg.set({"CLIENT_CANARY_STATE":"none","DEVICE":"ceng\\u003dUSER_DEFINED"});',
    'document.querySelector("#player").play();'
  ]
  const prose = [
    'Obsidian хранит заметки как обычные markdown-файлы в локальной папке без облака.',
    'Wikilinks connect notes into a graph you can open and inspect from the sidebar.'
  ]
  for (const line of junk) if (!looksLikeCode(line)) throw new Error(`selftest: junk passed the filter: ${line}`)
  for (const line of prose) if (looksLikeCode(line)) throw new Error(`selftest: prose rejected by the filter: ${line}`)
  if (readmePoints(junk.concat(prose).join('\n'), 6).length !== prose.length) throw new Error('selftest: readmePoints kept the wrong lines')
  console.log(JSON.stringify({ ok: true, selftest: 'source-scrape junk filter' }))
  process.exit(0)
}

const records = await listRecords()
const clusters = new Map()
for (const record of records) {
  const id = classify(record.text)
  if (!clusters.has(id)) clusters.set(id, { id, records: [] })
  clusters.get(id).records.push(record)
}

let written = 0
let skipped = 0
let atomized = 0
let enriched_clusters = 0
let failed_parts = 0
const useAtomize = DEEP && llmAvailable()
if (DEEP && !llmAvailable()) {
  console.error('[synthesize] --deep requested but LLM unavailable; falling back to local template synthesis')
  if (STRICT_ENRICH) {
    console.error('[synthesize] strict enrichment requires an available LLM')
    console.log(JSON.stringify({ ok: false, degraded: true, records: records.length, clusters: clusters.size, written: 0, atomized: 0, enriched: 0, failed_parts: clusters.size, skipped: 0 }, null, 2))
    process.exit(1)
  }
}
// Bounded-concurrency pool — the research swarm. Each part is an independent
// agent task; one failing never blocks the others (each is try/caught inside).
async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]) }
  })
  await Promise.all(workers)
}

async function processPart(part, parts, index) {
  if (useAtomize) {
    try {
      const sources = publicSources(part.records.map(r => r.text).join('\n\n'))
      // Expand the knowledge first (research), then atomize the EXPANDED material.
      let material
      if (ENRICH) {
        try {
          // GitHub API/README is a real primary source, so it stays first. The
          // generic page-scrape path builds a canned topic template and skips the
          // LLM atomizer, so it only runs when the LLM enricher gave nothing.
          let deterministic = await enrichClusterFromGithub(part, sources)
          let llmEnriched = null
          if (!deterministic) {
            llmEnriched = await enrichCluster(part, sources).catch(() => null)
            if (!llmEnriched?.enriched || (llmEnriched.addedFacts || []).length < MIN_ADDED_FACTS) {
              deterministic = await enrichClusterFromSources(part, sources)
              if (deterministic) llmEnriched = null
            }
          }
          const { enriched, addedSources, addedFacts } = deterministic || llmEnriched || { enriched: '', addedSources: [], addedFacts: [] }
          if (enriched && enriched.length > 200) {
            material = enriched
            for (const u of addedSources) if (!sources.some(s => s.url === u)) sources.push({ name: hostOf(u) || 'Source', url: u })
            part.enrichment = {
              ok: true,
              addedFacts,
              addedSources,
              deterministic: Boolean(deterministic),
              kind: deterministic?.github ? 'github' : deterministic ? 'sources' : 'llm',
              github: deterministic?.github || null,
              sourceFacts: deterministic?.sourceFacts || null
            }
            enriched_clusters += 1
          }
        } catch (err) {
          console.error(`[synthesize] enrich failed for cluster ${part.id}: ${err.message}`)
        }
      }
      if (STRICT_ENRICH && (!material || !part.enrichment?.ok || (part.enrichment.addedFacts || []).length < MIN_ADDED_FACTS || !sources.length)) {
        throw new Error(`strict enrichment failed for cluster ${part.id}: no expanded material with external facts/sources`)
      }
      const atoms = part.enrichment?.deterministic
        ? atomsFromDeterministic(part, sources)
        : await atomizeCluster(part, sources, material)
      let wroteAtom = false
      const allowedSourceUrls = new Set(sources.map(source => source.url).filter(isPublicHttpUrl))
      // Atom verdicts are independent read-only calls, so they are collected in
      // parallel (same verifyDeep args — call quality is unchanged). File writes
      // and counters stay serial. Cap via MNEMAZINE_VERIFY_CONCURRENCY.
      const pendingAtoms = []
      for (const atom of atoms) {
        atom.sources = (atom.sources || []).filter(url => allowedSourceUrls.has(url))
        const out = path.join(VAULT, '01 Concepts', `synthesis-${slugify(atom.title)}-${atomFingerprint(atom, part.id)}.md`)
        if (await fs.access(out).then(() => true).catch(() => false)) { skipped += 1; continue }
        pendingAtoms.push({ atom, out, verdict: null })
      }
      const VERIFY_CONCURRENCY = Math.max(1, Number(process.env.MNEMAZINE_VERIFY_CONCURRENCY || '8'))
      await mapLimit(pendingAtoms, VERIFY_CONCURRENCY, async (entry) => {
        entry.verdict = part.enrichment?.deterministic
          ? { status: 'verified', checked: entry.atom.sources || [], evidence: part.enrichment.kind === 'github' ? 'Fetched GitHub API/README/release for primary-source enrichment.' : 'Fetched public source pages from configured source hints.', note: `deterministic ${part.enrichment.kind} source check` }
          : DEEP
            ? await verifyDeep(`${entry.atom.what}\n${entry.atom.why}`, entry.atom.sources, { provider: VERIFIER_PROVIDER, label: `verify:${part.id}` })
            : verifyLocal(entry.atom.sources)
      })
      for (const { atom, out, verdict } of pendingAtoms) {
        if (STRICT_ENRICH && verdict.status !== 'verified') {
          console.error(`[synthesize] strict verification rejected atom "${atom.title}": ${verdict.status}`)
          continue
        }
        await fs.writeFile(out, makeAtomNote(part, atom, verdict), 'utf8')
        atomized += 1
        wroteAtom = true
      }
      if (wroteAtom) return // atomized this cluster — skip the template note
      // Strict verify rejected every atom. Writing nothing leaves the source
      // "unvisited": the next run re-atomizes it, gets fresh fingerprints and
      // re-verifies from scratch — the loop that burned 1755 verify calls on one
      // source. Fall through to the honest draft note instead (its own verdict
      // fields stay unverified), so the source has an artifact and stops recurring.
      if (STRICT_ENRICH) {
        console.error(`[synthesize] strict verification rejected all atoms for cluster ${part.id}; writing honest draft note instead of looping`)
      } else {
        console.error(`[synthesize] atomize produced no atoms for cluster ${part.id}; using template note`)
      }
    } catch (err) {
      if (STRICT_ENRICH) throw err
      console.error(`[synthesize] atomize failed for cluster ${part.id}: ${err.message}; using template note`)
    }
  }

  const suffix = parts.length > 1 ? `-part-${index + 1}` : ''
  // Filename keyed by content fingerprint, not date: idempotent across runs.
  const fp = fingerprint(part)
  const out = path.join(VAULT, '01 Concepts', `synthesis-${slugify(clusterTitle(part.id))}${suffix}-${fp}.md`)
  if (await fs.access(out).then(() => true).catch(() => false)) { skipped += 1; return }
  await fs.writeFile(out, makeNote(part), 'utf8')
  written += 1
}

const tasks = []
for (const cluster of clusters.values()) {
  const parts = chunks(cluster.records, CLUSTER_CHUNK_SIZE)
  parts.forEach((recs, index) => {
    const part = { ...cluster, records: recs, part: index + 1, partCount: parts.length }
    const textSize = part.records.reduce((sum, record) => sum + compact(record.text, 100000).length, 0)
    if (textSize < MIN_CLUSTER_CHARS) return
    tasks.push({ part, parts, index })
  })
}
// Swarm only helps when each task spawns an agent (deep); local template writes
// stay serial. Cap concurrency so we are cheap+fast, not a fork bomb.
// Premium-tier CLIs are rate-limited/expensive → run atomization serial; cheaper
// tiers parallelize. Read from the registry (cost_tier), never a name list.
const DEFAULT_CONCURRENCY = providerCostTier(RESOLVED_ATOMIZER_PROVIDER) === 'premium' ? '1' : '4'
const CONCURRENCY = Number(arg('concurrency', process.env.MNEMAZINE_CONCURRENCY || DEFAULT_CONCURRENCY))
await mapLimit(tasks, useAtomize ? CONCURRENCY : 1, async ({ part, parts, index }) => {
  // Outer guard: a part must never break the swarm, even on an unexpected throw.
  try { await processPart(part, parts, index) }
  catch (err) { failed_parts += 1; console.error(`[synthesize] part failed for cluster ${part.id}: ${err.message}`) }
})

// degraded: --deep was requested but the deep path could not run (codex absent),
// so the run silently fell back to local templates. Callers can detect this.
const degraded = DEEP && !llmAvailable()
const ok = !(STRICT_ENRICH && failed_parts > 0)
console.log(JSON.stringify({ ok, degraded, records: records.length, clusters: clusters.size, written, atomized, enriched: enriched_clusters, failed_parts, skipped }, null, 2))
if (!ok) process.exit(1)
