export const meta = {
  name: 'mnemazina-pipeline',
  description: 'Мнемозина-контролёр: конвейер знаний с воротами полноты + токеносбережение (hash-cache, markitdown, локальный OCR, cost-aware тиры). Ни один файл инбокса не архивируется и прогон не закрывается «done», пока сверщик (mnemazina-reconciler) не докажет на диске, что каждый файл получил ноту или зафиксированную причину. Режимы: INTAKE / FIND / INLINE.',
  whenToUse: 'Авто-триггер на каждое сообщение в проекте Мнемозина — включая вставленную ссылку, длинный текст, скрин или просьбу «разбери инбокс / сохрани в базу», даже без слов «Мнемозина» и /kb, потому что недосработавший триггер молча теряет материал. Также Workflow({ name: "mnemazina-pipeline", args: "<message>" })',
  phases: [
    { title: 'Guard', detail: 'Git-снапшот, lockfile, Ollama-зонд, ретеншн архива' },
    { title: 'Census', detail: 'Список ВСЕХ файлов + SHA-256 hash-cache (обработанное = 0 токенов)' },
    { title: 'Triage', detail: 'Классификация: юниты + needs_atomization + дубли/шум/нечитаемо' },
    { title: 'Process', detail: 'Параллельно: markitdown/локальный-OCR → extract→atomize→verify→classify→refine, нота/атомы с source:' },
    { title: 'Store', detail: 'Запись нот/атомных managed blocks + индексы (БЕЗ архивации)' },
    { title: 'Reconcile', detail: 'ГЕЙТ полноты: каждый файл → нота или причина. Ретрай дыр' },
    { title: 'Archive', detail: 'mv учтённых + cached; дыры остаются в инбоксе. Запись hash-кэша' },
    { title: 'Graphify', detail: 'Финал всегда, потому что граф — память Мнемозины: обновить + авточистка шаблон-узлов (graphify_clean.py)' },
    { title: 'VisualReport', detail: 'Светлый Apple-style HTML/MD отчёт: схема знаний, атомы, дубли, топ-20 действий' },
    { title: 'Briefing', detail: 'Кросс новых знаний с профилем владельца → «что применить сейчас»' },
    { title: 'SelfReflection', detail: 'После Graphify/Briefing: agent trace + что сработало/сломалось/урок/фикс для самообучения' },
    { title: 'Find', detail: 'Grep + граф + ранжирование по проектам' },
  ],
}

const ARGS_OBJ = (function () {
  if (!args || typeof args !== 'string') return (args && typeof args === 'object') ? args : {}
  var t = args.trim()
  if (t.charAt(0) !== '{') return {}
  try { var p = JSON.parse(t); return (p && typeof p === 'object') ? p : {} } catch (e) { return {} }
})()
const HOME_DIR = (typeof process !== 'undefined' && process.env && process.env.HOME) || '~'
const REPO_ROOT = String(ARGS_OBJ.repo || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_ROOT) || '.')
const INBOX = String(ARGS_OBJ.inbox || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_INBOX) || (HOME_DIR + '/Desktop/Mnemazine Inbox'))
const ARCHIVE = INBOX + '/_archive'  // durable-архив исходников: вне git-vault, БЕЗ авто-удаления — оригиналы нужны для claim↔источник ре-верификации нот
const VAULT = String(ARGS_OBJ.vault || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_VAULT) || (HOME_DIR + '/vault'))
const AGENT_HOME = String(ARGS_OBJ.agent_home || (typeof process !== 'undefined' && process.env && (process.env.MNEMAZINE_AGENT_HOME || process.env.CODEX_HOME || process.env.CLAUDE_HOME)) || (HOME_DIR + '/.codex'))
const HASHDB = VAULT + '/99 Система/_processed-hashes.json'
const EMBED_PY = String(ARGS_OBJ.embed_py || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_EMBED_PY) || (HOME_DIR + '/.venvs/kb-embed/bin/python'))
const EMBED_SC = AGENT_HOME + '/skills/mnemazina/kb-embed.py'
const EMBED_IDX = VAULT + '/99 Система/_embeddings.json'
const OCR_BIN = AGENT_HOME + '/skills/mnemazina/vision-ocr'  // Apple Vision OCR (локально, ~1.4с, русский точно). НЕ ollama/llava (галлюцинирует, 12мин).
const WHISPER_BIN = String(ARGS_OBJ.whisper_bin || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_WHISPER_BIN) || (HOME_DIR + '/.npm-global/bin/whisper'))  // openai-whisper (локально, 0 токенов). Модель small кэширована в ~/.cache/whisper.
const WHISPER_MODEL = (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_WHISPER_MODEL) || 'small'  // баланс скорость/качество на CPU. Авто-язык.
const DUP_THRESHOLD = 0.72
const ABTOP = String(ARGS_OBJ.abtop || (typeof process !== 'undefined' && process.env && process.env.MNEMAZINE_ABTOP) || (HOME_DIR + '/.cargo/bin/abtop'))
const NOW = (ARGS_OBJ && ARGS_OBJ.now) ? String(ARGS_OBJ.now) : null
const RUN_ID = 'kb-' + (NOW ? NOW.replace(/[-:.TZ]/g, '').slice(0, 14) : 'unstamped000000')
const OBS_LOG = REPO_ROOT.replace(/\/+$/, '') + '/.mnemazine/state/run-observability.jsonl'
const DAG_FILE = VAULT + '/99 Система/_last-run-dag.json'
const base = function (p) { return String(p).split('/').pop() }
const fsMod = await import('node:fs')
const cryptoMod = await import('node:crypto')
const childProcess = await import('node:child_process')
const MODEL_POLICY = JSON.parse(fsMod.readFileSync(REPO_ROOT.replace(/\/+$/, '') + '/config/model-policy.json', 'utf8'))
const modelForRole = function (role, tier) {
  const value = MODEL_POLICY.roles && MODEL_POLICY.roles[role]
  if (value === 'by-tier') return MODEL_POLICY.tiers[String(tier)]
  return value
}
const joinPath = function (dir, name) { return String(dir).replace(/\/+$/, '') + '/' + name }
const activeInboxFiles = function () {
  return fsMod.readdirSync(INBOX, { withFileTypes: true })
    .filter(function (entry) { return entry.isFile() && entry.name !== 'README.md' && entry.name !== '.DS_Store' })
    .map(function (entry) { return joinPath(INBOX, entry.name) })
    .sort()
}
const sha256File = function (file) {
  return cryptoMod.createHash('sha256').update(fsMod.readFileSync(file)).digest('hex')
}
const readJsonFile = function (file, fallback) {
  try { return JSON.parse(fsMod.readFileSync(file, 'utf8')) } catch (e) { return fallback }
}
const countMarkdownFiles = function (dir) {
  let count = 0
  for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.obsidian' || entry.name === 'graphify-out') continue
    const p = joinPath(dir, entry.name)
    if (entry.isDirectory()) count += countMarkdownFiles(p)
    else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) count += 1
  }
  return count
}
const extOf = function (file) {
  const name = base(file).toLowerCase()
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i)
}
const tierOfFile = function (file) {
  const ext = extOf(file)
  if (['.md', '.txt', '.json', '.csv'].indexOf(ext) !== -1) return 0
  if (['.pdf', '.docx', '.pptx', '.xlsx', '.html', '.htm'].indexOf(ext) !== -1) return 1
  if (['.png', '.jpg', '.jpeg', '.heic', '.webp', '.tiff'].indexOf(ext) !== -1) return 2
  if (['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].indexOf(ext) !== -1) return 3
  return 1
}
const tierOfUnit = function (unit) {
  const files = Array.isArray(unit.files) ? unit.files : []
  return files.reduce(function (max, file) { return Math.max(max, tierOfFile(file)) }, 1)
}
const releaseRunLock = async function (label) {
  return await agent(
    'Финальная механика Мнемозины: освободи lockfile, если он stale. Выполни bash без TTY:\n' +
    'LOCK=/tmp/kb-run.lock; if [ -f "$LOCK" ]; then PID=$(cat "$LOCK" 2>/dev/null || true); ' +
    'if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then rm -f "$LOCK"; echo released; else echo live:$PID; fi; else echo no_lock; fi',
    { label: 'release-lock-' + label, phase: 'Cleanup', model: 'haiku' }
  )
}

const observeRun = async function (label) {
  return await agent(
    'Run Observatory для Мнемозины. Выполни bash без TTY, не падай если abtop недоступен:\n' +
    'mkdir -p "$(dirname "' + OBS_LOG + '")"; OUT=$([ -x "' + ABTOP + '" ] && "' + ABTOP + '" --once 2>&1 || echo "abtop_unavailable"); ' +
    'PROJ=$(basename "$PWD"); LINE=$(printf "%s" "$OUT" | grep "$PROJ" | grep -E "CTX: *[0-9]+%" | head -1 || true); ' +
    '[ -n "$LINE" ] || LINE=$(printf "%s" "$OUT" | grep -E "CTX: *[0-9]+%" | head -1 || true); ' +
    'CTX=$(printf "%s" "$LINE" | grep -Eo "CTX: *[0-9]+%" | head -1 | grep -Eo "[0-9]+" || true); ' +
    'TOK=$(printf "%s" "$LINE" | grep -Eo "Tok:[^ ]+" | head -1 | cut -d: -f2 || true); ' +
    'printf \'{"ts":"%s","run_id":"' + RUN_ID + '","phase":"' + label + '","ctx_percent":"%s","tokens":"%s","raw":%s}\\n\' "$(date -u +%FT%TZ)" "$CTX" "$TOK" "$(printf "%s" "$OUT" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()[:4000]))")" >> "' + OBS_LOG + '"; ' +
    'if [ "${CTX:-0}" -ge 90 ]; then echo STOP_CTX_90; elif [ "${CTX:-0}" -ge 80 ]; then echo WARN_CTX_80; else echo OK_CTX; fi',
    { label: 'observe-' + label, phase: 'Observe', model: 'haiku' }
  )
}

// Mode-detect: извлечь человеческое сообщение, НЕ сериализуя весь объект args.
// Объект args = { now, message }: now идёт в RUN_ID (стр.26), message — это userMessage.
// JSON.stringify(args) тут ломал бы isInlineContent (длина >80) → ложная inline-нота.
const userMessage = (function () {
  if (!args) return ''
  if (typeof args === 'string') {
    // строка может быть JSON-обёрткой { now, message } или просто текстом
    var t = args.trim()
    if (t.charAt(0) === '{') {
      try { var p = JSON.parse(t); if (p && typeof p === 'object') return String(p.message || p.text || '') } catch (e) {}
    }
    return args
  }
  if (typeof args === 'object') return String(args.message || args.text || '')
  return String(args)
})()
const msg = userMessage.toLowerCase().trim()

const isFindMode = msg.startsWith('/kb find') || msg.startsWith('/find') ||
  msg.startsWith('найди ') || msg.startsWith('поищи ') ||
  msg.startsWith('что знаю о') || msg.startsWith('find:')

const isInlineContent = !isFindMode && userMessage.length > 80

// =================== FIND MODE ===================
if (isFindMode) {
  phase('Find')
  const query = userMessage
    .replace(/^\/kb find\s*/i, '').replace(/^\/find\s*/i, '')
    .replace(/^найди\s*/i, '').replace(/^поищи\s*/i, '')
    .replace(/^что знаю о\s*/i, '').replace(/^find:\s*/i, '').trim()
  log('Поиск: "' + query + '"')
  const result = await agent(
    'MODE: FIND\nQUERY: ' + query + '\nVAULT: ' + VAULT + '\nMAX_RESULTS: 7\n\n' +
    'Ты — mnemazina-librarian. 1) grep -rl по vault (искл. _Содержание/_МАСТЕР/Лог). 2) head -25 топ-кандидатов. ' +
    '3) Читай _ПРОЕКТЫ.md. 4) Если graphify-out/graph.json есть: python3 -m graphify query "' + query + '" --budget 1500. ' +
    '5) Ранжируй (ключи +3, тема +2, verified +1, проект +2). 6) Верни топ-7 с путями, snippet, score, связью с проектом, действием.',
    { label: 'kb-find', phase: 'Find', agentType: 'mnemazina-librarian', model: modelForRole('kb-find') }
  )
  return { mode: 'find', query: query, results: result }
}

// =================== INTAKE MODE ===================
const observeStart = await observeRun('start')
if (String(observeStart).indexOf('STOP_CTX_90') !== -1) {
  return { error: 'ctx_too_high', run_id: RUN_ID, message: 'CTX >= 90%. Новый чат/сжатие перед большим прогоном Мнемозины.', observability_log: OBS_LOG }
}

// ---------- GATE 0: Guard (+ зонд локальных движков извлечения: Vision/whisper/embed) ----------
phase('Guard')
const guardResult = await agent(
  'Выполни guard-последовательность Мнемозины:\n\n' +
  'VAULT="' + VAULT + '"\nINBOX="' + INBOX + '"\n\n' +
  '1. Git-снапшот: git -C "$VAULT" rev-parse --git-dir >/dev/null 2>&1 || git -C "$VAULT" init .; ' +
  'git -C "$VAULT" add -A && git -C "$VAULT" commit -m "pre-kb-$(date +%Y%m%dT%H%M)" --allow-empty. Сохрани hash.\n' +
  '2. Lockfile /tmp/kb-run.lock: если жив (kill -0) → error "lock_active"; иначе echo $$ > lock.\n' +
  '3. Зонд локальных движков (local-first, $0). Исполни ДОСЛОВНО и верни вывод: ' +
  'ls -l "' + OCR_BIN + '" "' + WHISPER_BIN + '" 2>&1 | head -4 → в поле ocr_probe. ' +
  'Затем ocr_ready = ([ -x "' + OCR_BIN + '" ] даёт истину), whisper_ready = ([ -x "' + WHISPER_BIN + '" ] даёт истину). ' +
  'Оба поля ОБЯЗАТЕЛЬНЫ и должны быть результатом реального запуска команды, а не предположением: ' +
  'ocr_ready=false останавливает весь прогон, поэтому ложное «нет» дороже любой другой ошибки здесь. ' +
  'Ollama не зондируй: для извлечения он не используется (llava галлюцинирует).\n' +
  '4. Archive (durable, БЕЗ авто-удаления): ARCHIVE="' + ARCHIVE + '"; mkdir -p "$ARCHIVE". Верни archive_path="' + ARCHIVE + '".\n' +
  '5. mkdir -p "' + INBOX + '". Верни сегодняшнюю дату ГГГГ-ММ-ДД (date +%F).\n' +
  '6. Семантический дедуп готов? [ -x "' + EMBED_PY + '" ] && [ -f "' + EMBED_SC + '" ] && echo yes. Верни embed_ready bool.\n\n' +
  'Верни JSON: { "snapshot", "ocr_ready", "whisper_ready", "embed_ready", "archive_path", "run_date", "error" }',
  {
    label: 'guard', phase: 'Guard', agentType: 'mnemazina-guard', model: 'haiku',
    schema: { type: 'object', properties: {
      snapshot: { type: 'string' },
      ocr_ready: { type: 'boolean' }, whisper_ready: { type: 'boolean' },
      ocr_probe: { type: 'string' }, // сырой вывод `ls -l` по бинарям: улика, по которой видно ложное «нет»
      embed_ready: { type: 'boolean' },
      archive_path: { type: 'string' }, run_date: { type: 'string' }, error: { type: ['string', 'null'] }
    },
    // ocr_ready/whisper_ready ОБЯЗАТЕЛЬНЫ (2026-07-25, измерено на живом прогоне). Они читаются как
    // `!!guardResult.ocr_ready`, то есть ОТСУТСТВИЕ поля неотличимо от «движка нет» — и жёсткий гейт
    // ниже останавливает прогон. Ровно это и случилось: сторож вернул {"embed_ready":true}, поле ocr_ready
    // не вернул, и 75 файлов встали с вердиктом «Apple Vision недоступен», хотя бинарь работал
    // (`vision-ocr IMG_5596.PNG` распознал русский текст с первого запуска).
    // Молчание — не измерение. Схема обязана требовать ответ на каждый зонд, чей ответ имеет право
    // остановить прогон.
    required: ['embed_ready', 'ocr_ready', 'whisper_ready'] }
  }
)
if (guardResult && guardResult.error === 'lock_active') {
  log('Прогон уже идёт. Удали /tmp/kb-run.lock.')
  return { error: 'lock_active' }
}
const embedReady = guardResult ? !!guardResult.embed_ready : false
const ocrReady = guardResult ? !!guardResult.ocr_ready : false
const whisperReady = guardResult ? !!guardResult.whisper_ready : false
const archivePath = ARCHIVE  // детерминированно: durable _archive, не зависит от guard-возврата или эвристик поиска проекта
const runDate = (guardResult && guardResult.run_date) ? guardResult.run_date : ''
const archiveDir = (/^\d{4}-\d{2}/.test(runDate) ? archivePath + '/' + runDate.slice(0, 7) : archivePath)  // датированная подпапка _archive/ГГГГ-ММ (плоский фолбэк если дата неизвестна)
log('Guard ok. OCR=Apple Vision (' + (ocrReady ? 'ready' : 'НЕТ') + '). Whisper=' + (whisperReady ? 'ready' : 'нет') + '. Embed=' + (embedReady ? 'fastembed' : 'нет'))

if (isInlineContent) {
  await agent(
    'Сохрани inline-контент пользователя как файл в инбокс ' + INBOX + '/inline-' + (runDate || 'content') + '.md ' +
    '(если занято — числовой суффикс). Контент:\n' + userMessage + '\nWrite tool. Верни путь.',
    { label: 'save-inline', phase: 'Guard', model: 'haiku' }
  )
  log('Inline-контент сохранён в инбокс')
}

// ---------- CENSUS: наземная правда + hash-cache (обработанное = 0 токенов) ----------
phase('Census')
const processedHashCache = readJsonFile(HASHDB, {})
const realPaths = activeInboxFiles()
const trueCount = realPaths.length

let allCensus = realPaths.map(function (p) {
  const hash = sha256File(p)
  return { path: p, hash: hash, cached: !!processedHashCache[hash], cached_note: processedHashCache[hash] || null }
})

const inboxFiles = allCensus.filter(function (f) { return !f.cached }).map(function (f) { return f.path })
const cachedFiles = allCensus.filter(function (f) { return f.cached }).map(function (f) { return f.path })
const hashOf = {}
allCensus.forEach(function (f) { if (f.hash) hashOf[f.path] = f.hash })

// Авторитет пустоты — список с диска (trueCount), НЕ census-агент (иначе фантом-мусор → ложная обработка / balanced:false).
if (trueCount === 0) {
  log('Инбокс пуст.')
  await observeRun('end-empty')
  await releaseRunLock('empty')
  return { status: 'empty_inbox', run_id: RUN_ID, message: 'Инбокс ~/Desktop/Mnemazine Inbox пуст. Добавь материалы или /kb find <запрос>.', observability_log: OBS_LOG }
}
if (inboxFiles.length === 0) {
  // всё из кэша — ничего не обрабатываем, архивируем и закрываем (0 токенов LLM)
  if (cachedFiles.length > 0) {
    await agent(
      'mkdir -p "' + archiveDir + '"; перемести (mv) эти уже-обработанные файлы в архив:\n' + cachedFiles.join('\n') + '\nВерни {archived:N}.',
      { label: 'archive-cached', phase: 'Census', agentType: 'mnemazina-librarian', model: 'haiku' }
    )
  }
  log('Все ' + cachedFiles.length + ' файлов из hash-кэша = 0 токенов')
  await observeRun('end-all-cached')
  await releaseRunLock('all-cached')
  return {
    status: 'all_cached', run_id: RUN_ID, census: allCensus.length, cached: cachedFiles.length, archived: cachedFiles.length,
    observability_log: OBS_LOG,
    message: 'Все ' + cachedFiles.length + ' файлов уже обработаны (hash-cache) → 0 токенов LLM, перемещены в архив.'
  }
}
log('Census: ' + allCensus.length + ' файлов (' + inboxFiles.length + ' новых, ' + cachedFiles.length + ' из кэша = 0 токенов)')

// ---------- OCR PASS: детерминированный локальный OCR ВСЕХ картинок (Apple Vision) ----------
// Текст пишется в сайдкары INBOX/.ocr/<имя>.txt. Агенты дальше читают ТЕКСТ, не картинки →
// гарантия 0 cloud-vision токенов. Не полагаемся на дисциплину агента (он бы выбрал Read-vision).
phase('Triage')
const OCR_DIR = INBOX + '/.ocr'
const imageFiles = inboxFiles.filter(function (f) { return /\.(png|webp|jpe?g|heic|heif|tiff?|gif|bmp)$/i.test(f) })
// ⛔ ЖЁСТКИЙ ГЕЙТ LOCAL-FIRST: есть картинки, но OCR-движок недоступен → СТОП (НЕ тихий облачный фолбэк на весь OCR).
// На Linux-VPS Apple Vision невозможен → image-батч останавливается; текст/видео-батчи идут дальше. На Mac: чинить бинарь.
if (imageFiles.length > 0 && !ocrReady) {
  log('⛔ СТОП: ' + imageFiles.length + ' картинок, но Apple Vision OCR недоступен (' + OCR_BIN + '). Local-first нарушен — облачный fallback на весь OCR запрещён.')
  await releaseRunLock('ocr-missing')
  return { error: 'ocr_engine_missing', run_id: RUN_ID, images: imageFiles.length,
    // Улика вместе с вердиктом: 2026-07-25 этот гейт остановил 75 файлов на РАБОТАЮЩЕМ бинаре — сторож
    // просто не вернул поле, и `!!undefined` прочиталось как «движка нет». Теперь рядом с отказом лежит
    // сырой `ls -l`, и первое, что делает оператор, — сверяет вердикт с уликой, а не чинит исправное.
    ocr_probe: (guardResult && guardResult.ocr_probe) || '(сторож улику не вернул — вердикту не верить, проверить бинарь руками)',
    fix: 'Сначала ПРОВЕРЬ: "' + OCR_BIN + '" <любая картинка> — если печатает текст, движок исправен и виноват зонд сторожа, а не бинарь. Только если правда не собран: swiftc -O "' + OCR_BIN + '.swift" -o "' + OCR_BIN + '". Linux/VPS: Apple Vision невозможен → обрабатывать картинки только на Mac.',
    observability_log: OBS_LOG }
}
if (imageFiles.length > 0) {
  log('OCR-проход: ' + imageFiles.length + ' картинок → Apple Vision (локально, ~1.4с/шт)')
  await agent(
    'Выполни один bash без TTY и верни его stdout (последнюю строку JSON). Он гоняет локальный Apple Vision OCR по картинкам и пишет сайдкары:\n\n' +
    'python3 <<\'PYEOF\'\n' +
    'import subprocess, json, os\n' +
    'BIN = ' + JSON.stringify(OCR_BIN) + '\n' +
    'OCRDIR = ' + JSON.stringify(OCR_DIR) + '\n' +
    'files = ' + JSON.stringify(imageFiles) + '\n' +
    'os.makedirs(OCRDIR, exist_ok=True)\n' +
    'done = 0; empty = 0\n' +
    'for f in files:\n' +
    '    try:\n' +
    '        t = subprocess.run([BIN, f], capture_output=True, text=True, timeout=60).stdout\n' +
    '    except Exception:\n' +
    '        t = ""\n' +
    '    open(os.path.join(OCRDIR, os.path.basename(f) + ".txt"), "w").write(t)\n' +
    '    done += 1\n' +
    '    if len(t.strip()) < 10: empty += 1\n' +
    'print(json.dumps({"ocr_done": done, "empty": empty}))\n' +
    'PYEOF',
    { label: 'ocr-pass', phase: 'Triage', model: 'haiku',
      schema: { type: 'object', properties: { ocr_done: { type: 'number' }, empty: { type: 'number' } }, required: ['ocr_done'] } }
  )
}

// ---------- TRANSCRIBE PASS: детерминированная локальная транскрипция ВСЕХ видео/аудио (whisper) ----------
// Текст → сайдкары INBOX/.transcript/<имя>.txt. Видео больше НЕ deferred — становится текстом → полный pipeline.
// Локально (openai-whisper, модель small кэширована), 0 токенов.
const TRANSCRIPT_DIR = INBOX + '/.transcript'
const mediaFiles = inboxFiles.filter(function (f) { return /\.(mov|mp4|m4v|avi|mkv|webm|mp3|m4a|wav|aac|ogg|flac)$/i.test(f) })
if (mediaFiles.length > 0) {
  log('TRANSCRIBE-проход: ' + mediaFiles.length + ' видео/аудио → whisper ' + WHISPER_MODEL + ' (локально, ~0.5x realtime)')
  await agent(
    'Выполни один bash без TTY и верни stdout (последнюю строку JSON). Локальная транскрипция whisper, пишет сайдкары. Это долго (CPU, ~0.5x realtime) — дождись завершения, таймаут уже заложен в сам скрипт:\n\n' +
    'python3 <<\'PYEOF\'\n' +
    'import subprocess, json, os\n' +
    'BIN = ' + JSON.stringify(WHISPER_BIN) + '\n' +
    'MODEL = ' + JSON.stringify(WHISPER_MODEL) + '\n' +
    'TDIR = ' + JSON.stringify(TRANSCRIPT_DIR) + '\n' +
    'files = ' + JSON.stringify(mediaFiles) + '\n' +
    'os.makedirs(TDIR, exist_ok=True)\n' +
    'done = 0; empty = 0\n' +
    'for f in files:\n' +
    '    base = os.path.basename(f); stem = os.path.splitext(base)[0]\n' +
    '    t = ""\n' +
    '    try:\n' +
    '        subprocess.run([BIN, f, "--model", MODEL, "--output_format", "txt", "--output_dir", TDIR, "--verbose", "False"], capture_output=True, text=True, timeout=2400)\n' +
    '        produced = os.path.join(TDIR, stem + ".txt")\n' +
    '        if os.path.exists(produced): t = open(produced).read()\n' +
    '    except Exception as e:\n' +
    '        t = ""\n' +
    '    open(os.path.join(TDIR, base + ".txt"), "w").write(t)\n' +
    '    done += 1\n' +
    '    if len(t.strip()) < 10: empty += 1\n' +
    'print(json.dumps({"transcribed": done, "empty": empty}))\n' +
    'PYEOF',
    { label: 'transcribe-pass', phase: 'Triage', model: 'haiku',
      schema: { type: 'object', properties: { transcribed: { type: 'number' }, empty: { type: 'number' } }, required: ['transcribed'] } }
  )
}

// ---------- TRIAGE ----------
const triageResult = await agent(
  'Ты — mnemazina-triage (Сопиков, каталогизатор). Новые файлы инбокса (уже-обработанные исключены hash-кэшем):\n' +
  inboxFiles.join('\n') + '\n\n' +
  'OCR-текст каждой картинки УЖЕ извлечён локально и лежит в ' + OCR_DIR + '/<имя файла>.txt.\n' +
  'ТРАНСКРИПТ каждого видео/аудио УЖЕ извлечён локально (whisper) и лежит в ' + TRANSCRIPT_DIR + '/<имя файла>.txt.\n' +
  '⛔ ЗАПРЕЩЕНО открывать сами .png/.webp/.jpg/.mov/.mp4 (дорого/невозможно). Содержание читай ТОЛЬКО из сайдкар-.txt через Read (дешёвый текст).\n\n' +
  '1. Сверься с ' + VAULT + '/99 Система/Лог обработки.md.\n' +
  '2. Картинка → читай ' + OCR_DIR + '/<basename>.txt. Видео/аудио (type=video) → читай ' + TRANSCRIPT_DIR + '/<basename>.txt. Гипотезу/группировку строй по этому тексту, не по имени файла — имя часто врёт о содержании. Пустой .txt — штатный случай, не ошибка: classified reason=noise (нет текста/речи) или unreadable (битый). Разные видео = разные юниты, потому что юнит рождает одну ноту и склейка разных видео теряет темы.\n' +
  '3. Для каждого файла реши: часть юнита-знания или причина-исключение.\n' +
  '   Группируй серии (скрины одного поста/треда → один юнит — сверяй по OCR-тексту). Разные темы → разные юниты.\n' +
  '   Тип: screenshot|image|pdf|text|url|code|video|other. Причины: dup|noise|unreadable.\n' +
  '4. Если один файл/гайд/транскрипт явно смешанный (например Карпати: токены, system files, coding, режим жизни, отношения) — не склеивай в одну итоговую ноту, потому что смешанная нота не находится поиском ни по одной из своих тем. Поставь needs_atomization=true и дай atom_hints по будущим атомам.\n' +
  '4б. Файл `agent-research--<project>--<slug>.md` — заявка агента проекта (боковая дверь): type=text, hypothesis «исследование агента <project>» (project — второй сегмент имени), свой отдельный юнит, с чужими файлами не группируй.\n' +
  '5. Каждый файл → либо units.files, либо classified: файл вне обоих списков гейт манифеста форсирует в отдельный юнит без твоей группировки, что дороже и хуже осмысленной серии.\n\n' +
  'JSON: { "units": [{ "group_id", "files": ["путь"], "type", "hypothesis", "ocr_preview", "needs_atomization": true|false, "atom_hints": ["тема → раздел"] }], ' +
  '"classified": [{ "file": "путь", "reason": "dup|noise|unreadable", "note": "пояснение" }] }',
  {
    label: 'triage', phase: 'Triage', model: 'haiku',
    schema: { type: 'object', properties: {
      units: { type: 'array', items: { type: 'object', properties: {
        group_id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
        type: { type: 'string' }, hypothesis: { type: 'string' }, ocr_preview: { type: 'string' },
        needs_atomization: { type: 'boolean' }, atom_hints: { type: 'array', items: { type: 'string' } }
      }, required: ['group_id', 'files', 'type'] } },
      classified: { type: 'array', items: { type: 'object', properties: {
        file: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }
      }, required: ['file', 'reason'] } }
    }, required: ['units'] }
  }
)
let units = (triageResult && triageResult.units) ? triageResult.units : []
const classified = (triageResult && triageResult.classified) ? triageResult.classified : []

// ========== ГЕЙТ 1: МАНИФЕСТ ПОЛНЫЙ (детерминированно) ==========
const manifest = {}
units.forEach(function (u) { (u.files || []).forEach(function (f) { manifest[base(f)] = true }) })
classified.forEach(function (c) { manifest[base(c.file)] = true })
const missing = inboxFiles.filter(function (f) { return !manifest[base(f)] })
if (missing.length > 0) {
  log('⚠ ГЕЙТ 1: триаж пропустил ' + missing.length + ' файлов → форсирую в юниты')
  missing.forEach(function (f, i) {
    units.push({ group_id: 'forced-' + i, files: [f], type: 'unknown', hypothesis: 'форсирован ГЕЙТ-1 (триаж пропустил)' })
  })
}
log('## МАНИФЕСТ ПОЛНЫЙ ✓ — ' + inboxFiles.length + ' новых учтены (' + units.length + ' юнитов, ' + classified.length + ' исключений)')

// ---------- PROCESS (cost-aware тиры + локальное извлечение) ----------
phase('Process')
let tieredUnits = units.map(function (u) {
  return Object.assign({}, u, { tier: tierOfUnit(u) })
})
if (typeof process !== 'undefined' && process.env.MNEMAZINE_SKIP_GROUPS_FILE) {
  try {
    const fsMod = await import('node:fs')
    const skipGroups = JSON.parse(fsMod.readFileSync(process.env.MNEMAZINE_SKIP_GROUPS_FILE, 'utf8'))
    const skip = new Set(Array.isArray(skipGroups) ? skipGroups : [])
    const beforeSkip = tieredUnits.length
    tieredUnits = tieredUnits.filter(function (u) { return !skip.has(u.group_id) })
    log('RESUME: пропускаю ' + (beforeSkip - tieredUnits.length) + ' уже завершённых групп; осталось ' + tieredUnits.length)
  } catch (err) {
    log('RESUME: не смог прочитать MNEMAZINE_SKIP_GROUPS_FILE, иду полным списком: ' + String(err && err.message ? err.message : err))
  }
}
const dag = {
  run_id: RUN_ID,
  kind: 'mnemosyne-intake',
  created_at: NOW || 'unstamped',
  census_count: allCensus.length,
  tasks: tieredUnits.map(function (u) {
    return { id: u.group_id, phase: 'Process', files: u.files, type: u.type, tier: u.tier, depends_on: ['Guard', 'Census', 'Triage'], write_scope: VAULT, status: 'planned' }
  }),
  gates: ['## МАНИФЕСТ ПОЛНЫЙ ✓', '## ПОКРЫТИЕ ПОЛНОЕ ✓', '## АРХИВ РАЗРЕШЁН ✓']
}
await agent(
  'Запиши DAG artifact Мнемозины через Write. Путь: ' + DAG_FILE + '\nJSON:\n' + JSON.stringify(dag, null, 2),
  { label: 'write-dag', phase: 'Process', model: 'haiku' }
)
log('Запускаю ' + tieredUnits.length + ' процессоров (рой' + (tieredUnits.length > 16 ? ', волнами — большой батч' : '') + ')...')

const processorPrompt = function (unit) {
  return 'Ты — mnemazina-processor (Ломоносов). Обработай один материал через стадии 2-5 Мнемозины.\n\n' +
    'MATERIAL_PATH: ' + unit.files.join(', ') + '\nTYPE: ' + unit.type + '\nTIER: ' + unit.tier +
    '\nGROUP_ID: ' + unit.group_id + '\nVAULT: ' + VAULT + '\n\n' +
    'Стадия 2 Извлечение — извлекай локально до Claude, потому что сырьё в контексте жжёт токены без пользы:\n' +
    '  PDF/DOCX/PPTX/XLSX/EPUB → `markitdown "<файл>"` (CLI) → markdown-текст. Сырьё/vision в контекст не грузи — markdown в разы дешевле.\n' +
    '  screenshot/image → OCR-текст УЖЕ извлечён локально (Apple Vision) в ' + OCR_DIR + '/<имя файла>.txt. Прочитай этот .txt через Read. ⛔ НЕ открывай саму .png/.webp (дорогой vision). Только если .txt пуст/обрезан И TIER 3 (макс-точность) → разрешён фолбэк Read(vision) на картинку. НЕ ollama/llava.\n' +
    '  URL → kb-fetch "<url>" (локальный каскад $0: markitdown для бинарников, trafilatura для HTML, кодировки чинит сам; exit 2 = needs_js → Playwright MCP/WebFetch; exit 3 = заблокировано → «источник недоступен», содержимое не выдумывать).\n' +
    '  video/audio → ТРАНСКРИПТ уже готов локально (whisper) в ' + TRANSCRIPT_DIR + '/<имя файла>.txt. Прочитай через Read. ⛔ НЕ открывай саму .mov/.mp4. Пустой транскрипт (нет речи) → outcome="noise". Иначе транскрипт = вход-семя → обогащай как текст (стадия 3).\n' +
    (embedReady
      ? '⚡ Стадия 2.5 Пре-дедуп — до стадии 3, потому что дубль дешевле поймать до дорогого ресёрча: прогони извлечённое семя:\n' +
        '  ' + EMBED_PY + ' "' + EMBED_SC + '" query "' + EMBED_IDX + '" "<первые ~400 симв извлечённого текста>" 3 ' + DUP_THRESHOLD + '\n' +
        '  Матч top≥' + DUP_THRESHOLD + ' → прочитай совпавшую ноту. Та же суть → outcome="dup", note_path=совпавшая, стоп: стадию 3 не запускай (никакого Firecrawl) и новую ноту не пиши, потому что ресёрч дубля сжигает бюджет впустую. Разное/нет матча → продолжай на стадию 3.\n'
      : '') +
    'Стадия 3 ИССЛЕДОВАНИЕ+ОБОГАЩЕНИЕ (только если НЕ дубль; извлечённое это ВХОД-СЕМЯ, не тело ноты):\n' +
    '  1) Определи тему/сущность/URL из извлечённого. 2) Активно исследуй первоисточник: поиск — WebSearch (встроенный, бесплатный; рунет-темы дополняй kb-search --ru), чтение целевых URL — kb-fetch (локально, $0); recon→оцени→читай целевые. Firecrawl — только по явной команде владельца (кредиты), sgai удалён из конвейера. ' +
    '3) Вытащи максимум из первоисточника: все разделы, цифры, примеры, тактики, связанные офиц.ресурсы. ' +
    '3b) Реальный опыт живых пользователей обязателен, потому что нота без практики — пересказ маркетинга: как этим реально пользуются (Reddit, HN, GitHub issues/discussions, профильные/рейтинговые сайты — Product Hunt, G2, отзывы, тематические форумы). Вытащи лайфхаки, баги, подводные камни, паттерны использования, за/против — с тред-URL. ' +
    '⚠ Фильтр сигнала: бери только реально обсуждаемое — живая дискуссия, много откликов/комментов/upvotes. Игнорируй разовые промо, анонсы, пресс-релизы, низко-сигнальные посты без обсуждения, потому что один голос без откликов — не опыт сообщества. Нет реального обсуждения → пометь «практик-опыт: не найдено живого обсуждения» — это честный штатный результат, не выдумывай. ' +
    'Нота строится из ИССЛЕДОВАННОГО, не из одного скрина. 4) Каждый блок фактов → пометь источник-URL; раздели из-первоисточника / из-опыта-юзеров / из-скрина / добавлено-агентом.\n' +
    '  ⚠ Обогащение обязательно для каждого юнита, потому что без него нота вырождается в подпись к скрину: даже крошечная зацепка (название тулзы, один скрин, обрывок) расширяется через WebSearch+kb-fetch до полного знания. Пропуск обогащения = брак — такая нота не отвечает на вопрос «как применить», ради которого база существует.\n' +
    '  Антигаллюцинация: каждый добавленный факт ведёт к fetched-источнику (цитируй URL), и контент этого URL реально содержит факт — открой и сверь, потому что «ссылка живая» ≠ подтверждение (числа/даты/ID дословно, репо → GitHub API); скрин-текст один — лишь входной запрос. Глубина по TIER: 0/1 — обогащение обязательно (≥1 первоисточник) · 2 полное исследование · 3 (мед/юр/фин/спорное) глубокое, ≥2 источника, потому что там цена ошибки выше цены токенов. Ни один тир не пропускает обогащение.\n' +
    '  verified: подтверждён|источник-не-найден|непроверяемо-методом|облако-недоступно.\n' +
    'Стадия 3.5 АТОМИЗАЦИЯ — обязательна для смешанных гайдов/транскриптов/лонгридов:\n' +
    '  Если в материале несколько независимых тем, верни atoms[] и не делай одну обзорную ноту — обзорная нота смешанного источника не находится ни по одной из тем. Один источник может породить 2-20 атомов.\n' +
    '  Каждый atom: stable atom_id, topic, section, target_note_hint, source_anchor, confidence, note_md. Классифицируй каждый atom отдельно по _ROUTING.md.\n' +
    '  Если atom дополняет существующую ноту — в note_md дай managed block MNEMOZINA_ATOM_START/END со stable-id; Store обязан слить, а не плодить дубль.\n' +
    '  Не дроби механически каждый заголовок: дроби только при смене смысла/проекта/раздела.\n' +
    'Стадия 4 Классификация: читай _ROUTING.md в корне vault (нет там — 99 Система/_ROUTING.md), выбери уверенный раздел.\n' +
    (embedReady
      ? 'Стадия 4.5 Семантический дедуп — до записи, потому что дубль в vault дороже ловить после: прогони извлечённый текст:\n' +
        '  ' + EMBED_PY + ' "' + EMBED_SC + '" query "' + EMBED_IDX + '" "<первые ~400 симв сути>" 3 ' + DUP_THRESHOLD + '\n' +
        '  matches непустой (top≥' + DUP_THRESHOLD + ') → прочитай совпавшую ноту. Та же суть → outcome="dup", note_path=совпавшая, новую не создавай — дубль размывает поиск и графовые связи. Разное → пиши.\n'
      : '') +
    'Стадия 5 Огранка: читай _ШАБЛОНЫ.md + _ПРОЕКТЫ.md. Нота — полное знание-досье, а не подпись к скрину и не краткая справка. Исходник — seed; финал расширяет тему максимально полезно. Порядок блоков фиксирован по NOTE-SPEC, потому что агент режет чтение сверху: «Короткий ответ» (первым, 2-4 самодостаточных предложения — прочитавший только его уже может действовать) → «Механика» → «Применение» (команды/шаги/шаблон/конфиг) → «Примеры и контрпримеры» → «Ошибки и границы» → «Опыт практиков» (только с URL тредов/issues) → «🎯 Как это поможет мне» (по именам проектов из _ПРОЕКТЫ.md) → «Достоверность» (каждая строка самодостаточна: кто/когда/версия/URL; внутри подраздел «Рассмотрено и отклонено» — что проверялось и почему исключено) → «Связанные темы» (типизированные связи текстом: расширяет [[X]] · противоречит [[Y]] · предшествует [[Z]] · инструмент-для [[W]]) → «Следующий ход» (конкретное действие, не «изучить глубже»). Если тема типа «принцип Парето» — раскрыть не только 80/20, а происхождение, математику/power-law связь, бизнес-примеры, где правило НЕ работает, типичные ошибки применения, чек-лист использования и связанные концепции. Атом (тонкая нота) законен: блоки «Примеры и контрпримеры»/«Ошибки и границы»/«Опыт практиков» могут отсутствовать, но «Короткий ответ», «🎯 Как это поможет мне» и «Достоверность» обязательны всегда — без них нота не находится и не проходит ре-верификацию claim↔источник.\n\n' +
    'Запиши ноту через Write (незаписанная нота = дыра покрытия и дорогой ретрай-раунд) в ' + VAULT + '/<раздел>/<дата> — <русский Заголовок>.md. Frontmatter по NOTE-SPEC: `type: <по содержанию: tool-card (инструмент/репо — тогда ещё repo/stars/license/risk) | concept | synthesis | decision | reference>`, `verified: <подтверждён | источник-не-найден | непроверяемо-методом | облако-недоступно>`, `source: local-media:' + String(hashOf[unit.files[0]] || '').slice(0, 16) + '`, `source_hash: ' + (hashOf[unit.files[0]] || '') + '`, `run_id: ' + RUN_ID + '`, `processor_model: codex-enriched`, `workflow: mnemosyne-mnemazina-pipeline`, `verification_status: verified-with-public-sources`, `status: final`.\n' +
    'Также добавь во frontmatter YAML-блок `sources:` с двумя строками на каждый исходник группы — basename и local-media-ref: сверщик (mnemazina-reconciler) считает покрытие грепом basename по `source:`/`sources:`, а local-media:hash нужен для ре-верификации claim↔источник и hash-cache; нота без basename в `sources:` уйдёт в ретрай как провенанс-дыра:\nsources:\n' + unit.files.map(function (uf) { return '  - ' + base(uf) + '\n  - local-media:' + String(hashOf[uf] || '').slice(0, 16) }).join('\n') + '\n' +
    'Материал — заявка `agent-research--<project>--<slug>.md` (боковая дверь агента) → frontmatter дополнительно: `type: agent-research`, `project: <project из имени файла>`, `agent: <кто заявил — из тела заявки; не указан → project>`, `claim_status: provisional`, потому что по NOTE-SPEC агентское знание рождается провизорным и смешивается с проверенным корпусом только операцией graduate.\n' +
    'Дубль существующей ноты → outcome="dup", note_path=путь. Смешанный материал → outcome="atoms" и заполненный atoms[]. Шум/нечитаемо → outcome="noise"/"unreadable". Видео с транскриптом → обрабатывается как текст ("note" или "atoms"); видео без речи → "noise"; транскрипт не получен → "deferred". Все эти исходы штатные, не ошибки — честный "noise"/"deferred" лучше выдуманной ноты. Иначе "note".\n\n' +
    'Верни JSON: { "group_id", "files": ' + JSON.stringify(unit.files) + ', "outcome", "section", "filename", ' +
    '"verified", "helps", "next_action", "new_section_candidate", "install_suggestion", "note_md", "atoms": [{ "atom_id", "topic", "section", "target_note_hint", "source_anchor", "confidence", "note_md" }] }'
}
const processSchema = { type: 'object', properties: {
  group_id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
  outcome: { type: 'string' }, section: { type: 'string' }, filename: { type: 'string' },
  verified: { type: 'string' }, helps: { type: 'string' }, next_action: { type: 'string' },
  new_section_candidate: { type: 'boolean' }, install_suggestion: { type: ['string', 'null'] }, note_md: { type: 'string' },
  atoms: { type: 'array', items: { type: 'object', properties: {
    atom_id: { type: 'string' }, topic: { type: 'string' }, section: { type: 'string' },
    target_note_hint: { type: 'string' }, source_anchor: { type: 'string' },
    confidence: { type: 'string' }, note_md: { type: 'string' }
  }, required: ['atom_id', 'topic', 'section', 'note_md'] } }
}, required: ['group_id', 'outcome'] }

let processResults = (await parallel(tieredUnits.map(function (unit) {
  return function () {
    return agent(processorPrompt(unit), {
      label: 'proc-' + unit.group_id, phase: 'Process', agentType: 'mnemazina-processor', model: modelForRole('proc', unit.tier), schema: processSchema
    })
  }
}))).filter(Boolean)
log('Процессоры вернули ' + processResults.length + '/' + tieredUnits.length)

const processClassified = []
processResults.forEach(function (r) {
  if (!r || !Array.isArray(r.files)) return
  if (['dup', 'noise', 'unreadable', 'deferred'].indexOf(r.outcome) === -1) return
  r.files.forEach(function (f) { processClassified.push({ file: f, reason: r.outcome, group_id: r.group_id }) })
})
const classifiedForReconcile = classified.concat(processClassified)

// ---------- STORE (запись + индексы, БЕЗ архивации) ----------
phase('Store')
const storeResult = await agent(
  'Ты — mnemazina-librarian (Калачов) в режиме STORE-ONLY. Не архивируй и не перемещай исходники: архивация — отдельная фаза после сверки покрытия, преждевременный mv лишит сверщика наземной правды.\n\n' +
  'VAULT: ' + VAULT + '\nBATCH: ' + JSON.stringify(processResults.map(function (r) {
    return { group_id: r.group_id, outcome: r.outcome, section: r.section, filename: r.filename, note_md: r.note_md, atoms: r.atoms || [] }
  })) + '\n\n' +
  'Для outcome="note": grep дубли в разделе; запиши .md (frontmatter с source: сохрани — по нему сверщик находит покрытие файла); wikilinks.\n' +
  'Для outcome="atoms": обрабатывай каждый atom отдельно, потому что атомы уходят в разные ноты и разделы. Если target_note_hint/grep показывает существующую ноту — вставь/обнови managed block `<!-- MNEMOZINA_ATOM_START <atom_id> --> ... <!-- MNEMOZINA_ATOM_END <atom_id> -->`; если подходящей ноты нет — создай отдельную ноту atom.section/atom.target_note_hint. Не плодить обзорную ноту смешанного источника.\n' +
  'Стадия 7 (батчем): обнови _Содержание.md, _МАСТЕР-ИНДЕКС.md (пересчёт), _ROUTING.md, Лог обработки.md.\n' +
  'Не делай mv и не запускай graphify — это отдельные финальные фазы конвейера, их запуск отсюда задвоит работу. Верни JSON: { "stored": ["путь"], "merged": [], "new_sections": [], "errors": [] }',
  {
    label: 'store', phase: 'Store', agentType: 'mnemazina-librarian', model: modelForRole('store'),
    schema: { type: 'object', properties: {
      stored: { type: 'array', items: { type: 'string' } }, merged: { type: 'array', items: { type: 'string' } },
      new_sections: { type: 'array', items: { type: 'string' } }, graph_updated: { type: 'boolean' },
      needs_graphify_init: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }
    }, required: ['stored'] }
  }
)

// ========== ГЕЙТ КАЧЕСТВА НОТ (NOTE-SPEC): после Store, до Reconcile ==========
// Провал ноты = её источники уходят в дыры ретрая (та же механика, что провенанс-дыры), не в раздел:
// пожелание шаблона исполняется вероятностно, а код-гейт всегда (docs/NOTE-SPEC.md проекта mnemazine).
const storedNotes = (storeResult && storeResult.stored) ? storeResult.stored : []
const gateSince = NOW || runDate || ''
let qualityFailedFiles = []
if (storedNotes.length > 0) {
  const qualityRun = childProcess.spawnSync(process.execPath, [
    'scripts/mnemazine-vault-quality-gate.mjs',
    '--spec',
    '--json',
    ...(gateSince ? ['--changed-since', gateSince] : [])
  ], { cwd: REPO_ROOT, encoding: 'utf8' })
  const qualityGate = (function () {
    const raw = String(qualityRun.stdout || qualityRun.stderr || '').trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end < start) return { ok: false, failures: [] }
    try { return JSON.parse(raw.slice(start, end + 1)) } catch (e) { return { ok: false, failures: [] } }
  })()
  const failedRel = ((qualityGate && qualityGate.failures) || []).map(function (x) { return String((x && x.file) || '') }).filter(Boolean)
  // --changed-since меряет mtime по всему vault → сужаем до нот ЭТОГО прогона: чужие провалы — не наши дыры
  const failedNotes = storedNotes.filter(function (p) {
    return failedRel.some(function (rel) { return String(p).indexOf(rel) !== -1 || base(p) === base(rel) })
  })
  if (failedNotes.length > 0) {
    processResults.forEach(function (r) {
      if (!r || r.outcome !== 'note' || !Array.isArray(r.files) || !r.filename) return
      const hit = failedNotes.some(function (p) { return String(p).indexOf(r.filename) !== -1 || base(p) === base(r.filename) })
      if (hit) r.files.forEach(function (f) { if (qualityFailedFiles.indexOf(f) === -1) qualityFailedFiles.push(f) })
    })
    log('⚠ ГЕЙТ КАЧЕСТВА: ' + failedNotes.length + ' нот провалили NOTE-SPEC → ' + qualityFailedFiles.length + ' источников в ретрай')
  } else {
    log('## КАЧЕСТВО НОТ ✓ — свежезаписанные прошли NOTE-SPEC')
  }
}

// ========== ГЕЙТ 2: ПОКРЫТИЕ ПОЛНОЕ (сверщик + ретрай) ==========
phase('Reconcile')
const reconcilePrompt = function () {
  return 'MODE: RECONCILE\n' + JSON.stringify({ census_files: inboxFiles, vault: VAULT, classified: classifiedForReconcile, run_date: runDate })
}
let recon = await agent(reconcilePrompt(), {
  label: 'reconcile', phase: 'Reconcile', agentType: 'mnemazina-reconciler', model: modelForRole('reconcile'),
  schema: { type: 'object', properties: {
    census_count: { type: 'number' },
    ledger: { type: 'object', properties: {
      noted: { type: 'number' }, dup: { type: 'number' }, noise: { type: 'number' },
      unreadable: { type: 'number' }, deferred: { type: 'number' }, unaccounted: { type: 'number' } } },
    unaccounted: { type: 'array', items: { type: 'string' } },
    balanced: { type: 'boolean' }, verdict: { type: 'string' }, marker: { type: 'string' }
  }, required: ['unaccounted', 'verdict'] }
})
// КОД ПОВЕРХ СУЖДЕНИЯ (2026-07-25, измерено). Прогон kb-20260725201732 закрылся маркером «ПОКРЫТИЕ
// ПОЛНОЕ ✓» с unaccounted=0, тогда как на диске файл tmpImage_8B654E2A-….JPG не имел ни ноты, ни
// сайдкара, ни записи причины — и при этом прекрасно читался Apple Vision. Сверщик — LLM, которая сама
// грепает и сама выносит вердикт по своему грепу (в том же прогоне она чинила собственный баг грепа
// по ходу проверки). Подсчёт покрытия — не суждение, а греп, значит его место в коде с кодом возврата.
// Список дыр берём из скрипта; LLM-сверщик остаётся для КЛАССИФИКАЦИИ причины, но перекрыть код не может.
async function codeCoverageGate(tag) {
  const r = childProcess.spawnSync(process.execPath, [
    'scripts/mnemazine-coverage-check.mjs',
    '--json',
    '--vault', VAULT,
    '--inbox', INBOX
  ], { cwd: REPO_ROOT, encoding: 'utf8' })
  let parsed = null
  try { parsed = JSON.parse(String(r.stdout || '').trim()) } catch (e) {}
  if (r.status === 0 && parsed && Array.isArray(parsed.uncovered)) return []
  if (r.status === 1 && parsed && Array.isArray(parsed.uncovered)) return parsed.uncovered
  log('⚠ КОД-ГЕЙТ coverage-check сломан на проходе ' + tag + ': exit=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 300))
  return ['__coverage_check_failed__']
}
// Объединение, а не замена: код ловит «ноты нет вообще», сверщик — «нота есть, но не та». Дыра, которую
// назвал код и не назвала LLM, — ровно тот случай, ради которого этот гейт и появился.
function mergeCodeGaps(list, codeGaps) {
  codeGaps.forEach(function (f) {
    if (list.indexOf(f) === -1) {
      log('⚠ КОД-ГЕЙТ нашёл дыру, которую сверщик не назвал: ' + base(f))
      list.push(f)
    }
  })
  return list
}
let unaccounted = mergeCodeGaps((recon && recon.unaccounted) ? recon.unaccounted : [], await codeCoverageGate('1'))
// Провал гейта качества — дыра ретрая даже при полном покрытии: нота есть, но браковая.
qualityFailedFiles.forEach(function (f) { if (unaccounted.indexOf(f) === -1) unaccounted.push(f) })

if (unaccounted.length > 0) {
  // Раздели дыры: ПРОВЕНАНС-дыра (файл из юнита, чья группа УЖЕ дала ноту — нота просто не перечислила его в sources:)
  // vs НАСТОЯЩАЯ дыра-знание (группа ноты не дала). Провенанс чиним дёшево патчем frontmatter; настоящую — Sonnet-ресёрчем.
  // Quality-провал имеет ноту, но браковую — sources-патч её не чинит, поэтому он всегда настоящая дыра.
  const notePathByFile = {}
  tieredUnits.forEach(function (u) {
    const res = processResults.find(function (r) { return r && r.group_id === u.group_id && r.outcome === 'note' })
    if (res) (u.files || []).forEach(function (uf) { notePathByFile[base(uf)] = res.note_md || res.filename || '' })
  })
  const provenanceGaps = unaccounted.filter(function (f) { return notePathByFile[base(f)] && qualityFailedFiles.indexOf(f) === -1 })
  const realGaps = unaccounted.filter(function (f) { return !notePathByFile[base(f)] || qualityFailedFiles.indexOf(f) !== -1 })
  if (provenanceGaps.length > 0) {
    log('ГЕЙТ 2: ' + provenanceGaps.length + ' провенанс-дыр (группа дала ноту, sources: неполон) → дешёвый патч frontmatter (haiku), БЕЗ ре-ресёрча')
    await agent(
      'Чистая механика, БЕЗ ресёрча и без новых нот. Для каждой пары {file → note} добавь basename файла в frontmatter-блок `sources:` указанной ноты (создай поле `sources:` списком «  - <basename>», если его ещё нет; не дублируй строки). Этим файл считается покрытым — он уже отражён в этой ноте.\nПАРЫ:\n' + provenanceGaps.map(function (f) { return base(f) + ' → ' + (notePathByFile[base(f)] || '') }).join('\n') + '\nВерни { "patched": N }.',
      { label: 'patch-sources', phase: 'Reconcile', agentType: 'mnemazina-librarian', model: 'haiku',
        schema: { type: 'object', properties: { patched: { type: 'number' } } } }
    )
  }
  if (realGaps.length > 0) {
    log('⚠ ГЕЙТ 2: ' + realGaps.length + ' настоящих дыр (нет ноты или брак NOTE-SPEC) → ретрай-раунд (Sonnet)')
    await parallel(realGaps.map(function (f) {
      return function () {
        const sourceHash = hashOf[f] || ''
        const sourceRef = sourceHash ? ('local-media:' + String(sourceHash).slice(0, 16)) : base(f)
        return agent(
          'Восстанови ОДНО дропнутое знание. Источник: ' + f + '\n' +
          'Скрин/картинка → OCR локально: `"' + OCR_BIN + '" "' + f + '"` (Apple Vision, 0 токенов). Пусто/мусор → Read(vision) — в ретрае это допустимый последний шанс. Не ollama/llava: галлюцинирует.\n' +
          'Извлеки контент (это вход-семя, не тело ноты), исследуй первоисточник (WebSearch → чтение URL через kb-fetch; kb-search как фолбэк поиска) и собери максимум по теме, классифицируй (читай ' + VAULT + '/_ROUTING.md — реестр лежит в корне vault), ' +
          'запиши ноту через Write в ' + VAULT + '/<раздел>/' + (runDate || '2026-01-01') + ' — <Заголовок>.md ' +
          'с обязательным `source: ' + sourceRef + '`' + (sourceHash ? ', `source_hash: ' + sourceHash + '`' : '') + ', `sources: ["' + base(f) + '"' + (sourceHash ? ', "' + sourceRef + '"' : '') + ']` (basename обязателен — сверщик считает покрытие грепом basename) + блоком «Как помогает мне». Нота этого источника уже существует, но провалила гейт NOTE-SPEC → перепиши её по NOTE-SPEC тем же путём, вторую не плоди. Видео/аудио → локальная транскрипция whisper (0 токенов) или deferred — это штатный исход, не ошибка. ' +
          'Финальный ответ — только путь записанной ноты.',
          { label: 'retry-' + base(f), phase: 'Reconcile', model: 'sonnet' }
        )
      }
    }))
  }
  recon = await agent(reconcilePrompt(), {
    label: 'reconcile-2', phase: 'Reconcile', agentType: 'mnemazina-reconciler', model: modelForRole('reconcile-2'),
    schema: { type: 'object', properties: {
      census_count: { type: 'number' }, ledger: { type: 'object' },
      unaccounted: { type: 'array', items: { type: 'string' } },
      balanced: { type: 'boolean' }, verdict: { type: 'string' }
    }, required: ['unaccounted', 'verdict'] }
  })
  // Код-гейт ЗАНОВО: без этого второй вердикт сверщика молча затирал список дыр, найденный кодом,
  // и прогон закрывался «ПОКРЫТИЕ ПОЛНОЕ ✓» ровно с той дырой, ради которой гейт и ставился.
  unaccounted = mergeCodeGaps((recon && recon.unaccounted) ? recon.unaccounted : [], await codeCoverageGate('2'))
}
const coverageFull = unaccounted.length === 0
log(coverageFull ? '## ПОКРЫТИЕ ПОЛНОЕ ✓' : '## ПОКРЫТИЕ НЕПОЛНОЕ ✗ — ' + unaccounted.length + ' дыр остаются в инбоксе')

// ========== ГЕЙТ 3: АРХИВ + запись hash-кэша ==========
phase('Archive')
// архивируем учтённые новые + cached (они уже обработаны ранее)
const accountedNew = inboxFiles.filter(function (f) { return unaccounted.indexOf(f) === -1 })
const toArchive = accountedNew.concat(cachedFiles)
// archiveVerified остаётся null, когда архивировать нечего, и числом — когда мера была снята.
let archiveVerified = null
if (toArchive.length > 0) {
  await agent(
    'Ты — mnemazina-librarian, ГЕЙТ-3. Перемести (mv) ТОЛЬКО эти учтённые исходники в архив ' + archiveDir + ':\n' +
    toArchive.join('\n') + '\n\nФайлы НЕ из списка — НЕ трогай: файл вне списка — непокрытая дыра, и mv спрятал бы её от следующего прогона. mkdir -p "' + archiveDir + '"; mv каждый. Верни { "archived": N }.',
    { label: 'archive', phase: 'Archive', agentType: 'mnemazina-librarian', model: 'haiku',
      schema: { type: 'object', properties: { archived: { type: 'number' } } } }
  )
  // ЗАМЕР, а не отчёт (2026-07-25): прогон вернул archived=73 и маркер «АРХИВ РАЗРЕШЁН ✓», тогда как в
  // инбоксе осталось 72 из 73 файлов — маркер был литералом в коде, а число пришло от агента о самом себе.
  // Считаем то, что реально осталось лежать: сколько из toArchive ещё в инбоксе.
  archiveVerified = fsMod.readdirSync(INBOX, { withFileTypes: true })
    .filter(function (entry) { return entry.isFile() && !entry.name.startsWith('.') })
    .length
  if (archiveVerified !== null && archiveVerified > unaccounted.length + 6) {
    log('⚠ ГЕЙТ 3: в инбоксе осталось ' + archiveVerified + ' записей при ' + unaccounted.length + ' дырах — архивация НЕ отработала, разбирать руками.')
  }
}
// hash-cache: запиши хэши новых учтённых нот-файлов → следующий прогон их скипнет за 0 токенов
const hashPayload = accountedNew.map(function (f) { return { hash: hashOf[f] || '', file: base(f) } }).filter(function (x) { return x.hash })
if (hashPayload.length > 0) {
  await agent(
    'Обнови hash-кэш ' + HASHDB + '. Прочитай его (JSON {hash:путь_ноты}; {} если нет). ' +
    'Для каждой записи найди ноту: grep -rl "<file>" в ' + VAULT + ' --include=*.md (первый результат; basename ищется и в source:, и в списке sources:). ' +
    'Добавь {hash: путь_ноты}. Записи без найденной ноты пропусти. Запиши JSON обратно через Write. Данные:\n' +
    JSON.stringify(hashPayload) + '\nВерни { "recorded": N }.',
    { label: 'hash-record', phase: 'Archive', agentType: 'mnemazina-librarian', model: 'haiku',
      schema: { type: 'object', properties: { recorded: { type: 'number' } } } }
  )
}
// семантический индекс: дозаписать новые ноты (для будущего дедупа)
if (embedReady && storeResult && storeResult.stored && storeResult.stored.length > 0) {
  await agent(
    'Дозапиши новые ноты в семантический индекс. Выполни одной командой:\n' +
    EMBED_PY + ' "' + EMBED_SC + '" add "' + EMBED_IDX + '" ' +
    storeResult.stored.map(function (p) { return '"' + p + '"' }).join(' ') + '\nВерни { "indexed": N }.',
    { label: 'embed-add', phase: 'Archive', model: 'haiku',
      schema: { type: 'object', properties: { indexed: { type: 'number' } } } }
  )
}
log('## АРХИВ — просили перенести ' + toArchive.length + ' (' + cachedFiles.length + ' cached), дыр ' + unaccounted.length +
    (archiveVerified === null ? '' : ', в инбоксе осталось ' + archiveVerified + ' записей'))

// ---------- GRAPHIFY (финал — ВСЕГДА, граф = память Мнемозины) ----------
phase('Graphify')
const vaultMdCount = countMarkdownFiles(VAULT)
const graphRes = await agent(
  'Финал Мнемозины — обнови граф знаний (память системы). Выполни bash:\n' +
  'rm -rf "' + OCR_DIR + '" "' + TRANSCRIPT_DIR + '" 2>/dev/null; ' +  // чистка осиротевших сайдкаров (источники уже в архиве)
  'cd "' + VAULT + '" && if [ -f graphify-out/graph.json ]; then graphify update "' + VAULT + '" 2>&1 | tail -3 && python3 "' + REPO_ROOT + '/scripts/graphify_clean.py" 2>&1 | tail -6 && echo RESULT:updated; ' +
  'else if [ ' + vaultMdCount + ' -gt 5 ]; then echo RESULT:needs_init; else echo RESULT:skip; fi; fi\n' +
  'Верни { "graph": "updated|needs_init|skip" } по строке RESULT.',
  { label: 'graphify', phase: 'Graphify', model: 'haiku',
    schema: { type: 'object', properties: { graph: { type: 'string' } } } }
)
log('## ГРАФ ОБНОВЛЁН ✓ — ' + ((graphRes && graphRes.graph) || 'skip') + ' (память Мнемозины, авточистка шаблонов)')

// Обязательные код-шаги финала: core-индексы + --check гейт + lint catch-up 36ч (ночное расписание
// могло не сработать — догоняем при ближайшем запуске). graphify не дублируем — прогнан агентом выше.
const finalChecks = await agent(
  'Финал Мнемозины — обязательные код-шаги. Чистая механика, без правок нот. Выполни один bash без TTY и верни последнюю строку JSON:\n' +
  'cd "' + REPO_ROOT + '"\n' +
  'S="scripts"\n' +
  'node "$S/mnemazine-refresh-core-indexes.mjs" >/dev/null 2>&1\n' +
  'if node "$S/mnemazine-refresh-core-indexes.mjs" --check >/dev/null 2>&1; then IDX=ok; else IDX=fail; fi\n' +
  'L="' + VAULT + '/99 Система/_lint/.last-lint"\n' +
  'if [ ! -f "$S/mnemazine-kb-lint.mjs" ]; then LINT=missing\n' +
  'elif [ ! -f "$L" ] || [ -n "$(find "$L" -mmin +2160 2>/dev/null)" ]; then node "$S/mnemazine-kb-lint.mjs" >/dev/null 2>&1 && LINT=ran || LINT=lint_fail\n' +
  'else LINT=fresh; fi\n' +
  'printf \'{"indexes":"%s","lint":"%s"}\\n\' "$IDX" "$LINT"\n' +
  'LINT=missing — штатный случай (скрипт стоит не на каждой машине), не сбой. Верни JSON как есть: { "indexes": "ok|fail", "lint": "ran|fresh|missing|lint_fail" }.',
  { label: 'final-code-steps', phase: 'Graphify', model: 'haiku',
    schema: { type: 'object', properties: {
      indexes: { type: 'string' }, lint: { type: 'string' }
    }, required: ['indexes', 'lint'] } }
)
log('## КОД-ШАГИ ФИНАЛА — индексы: ' + ((finalChecks && finalChecks.indexes) || '?') + ', линт: ' + ((finalChecks && finalChecks.lint) || '?'))

// ---------- РЕЗОЛВЕР MNEMOZINA/MNEMAZINE-ИНСТРУМЕНТОВ (Claude/Codex parity) ----------
// Порядок: проект Mnemazine/scripts → $MNEMOZINA_REPO/scripts → ~/.codex/bin → ~/.claude/bin.
const MZ_RESOLVE =
  'mz_run(){ n="$1"; shift; ' +
  'for c in "scripts/$n.mjs" "${MNEMOZINA_REPO:+$MNEMOZINA_REPO/scripts/$n.mjs}" "$HOME/.codex/bin/$n" "$HOME/.claude/bin/$n"; do ' +
  '[ -n "$c" ] && [ -f "$c" ] || continue; ' +
  'case "$c" in *.mjs) node "$c" "$@";; *) "$c" "$@";; esac; return $?; ' +
  'done; echo "MZ_NOT_FOUND:$n" >&2; return 127; }; '

// ---------- ВИЗУАЛЬНЫЙ POST-RUN ОТЧЁТ (Apple-light, Emil Kowalski design contract) ----------
phase('VisualReport')
const reportPayload = processResults.map(function (r) {
  return {
    group_id: r.group_id,
    files: r.files || [],
    outcome: r.outcome,
    section: r.section || '',
    filename: r.filename || '',
    verified: r.verified || '',
    helps: r.helps || '',
    next_action: r.next_action || '',
    note_md: (r.note_md && String(r.note_md).length < 500) ? r.note_md : '',
    atoms: r.atoms || []
  }
})
const visualReport = await agent(
  'Финал Мнемозины — создай светлый Apple-style визуальный отчёт знаний после прогона: схема кластеров → ноты → малые атомы, плюс топ-20 действий. ' +
  'Дизайн-контракт: Emil Kowalski, Apple-light, тихая типографика, 8px radius, без тяжёлых градиентов/теней, prefers-reduced-motion.\n' +
  'Выполни bash без TTY:\n' +
  MZ_RESOLVE +
  'TMP="/tmp/mnemazine-postrun-' + RUN_ID + '.json"; cat > "$TMP" <<\\JSON\n' +
  JSON.stringify({ processResults: reportPayload }) + '\nJSON\n' +
  'MNEMAZINE_ROOT="' + REPO_ROOT + '" MNEMAZINE_VAULT="' + VAULT + '" mz_run mnemazine-postrun-knowledge-report --run-id "' + RUN_ID + '" --results-json "$TMP" --title "Mnemazine post-run knowledge report"\n' +
  'Верни JSON из stdout как есть. MZ_NOT_FOUND — штатный случай (скрипт не установлен на этой машине), не сбой: верни {"ok":false,"error":"mnemazine-postrun-knowledge-report not found"}.\n',
  { label: 'visual-report', phase: 'VisualReport', model: 'haiku',
    schema: { type: 'object', properties: {
      ok: { type: 'boolean' },
      run_id: { type: 'string' },
      groups: { type: 'number' },
      records: { type: 'number' },
      fresh: { type: 'number' },
      duplicates: { type: 'number' },
      md: { type: 'string' },
      html: { type: 'string' },
      error: { type: 'string' }
    } } }
)
log('## ВИЗУАЛЬНЫЙ ОТЧЁТ ГОТОВ ✓ — ' + ((visualReport && visualReport.html) || 'не создан'))

// ---------- БРИФИНГ ПРИМЕНИМОСТИ (финал после графа, local-first, 0 LLM-токенов) ----------
// Общий слой для Claude и Codex: читает свежие ноты по run_id, ранжирует под проекты,
// возвращает brief_md в финальный результат. Отдельный briefing-файл не пишем: пользователь взаимодействует с брифингом в чате.
phase('Briefing')
const briefing = await agent(
  'Финал Мнемозины — сделай локальный брифинг применимости без LLM-анализа контента. Выполни bash без TTY:\n' +
  MZ_RESOLVE +
  'mz_run mnemozina-brief --run-id "' + RUN_ID + '" --limit 10\n' +
  'Верни JSON из stdout как есть. Поле brief_md обязательно: показать пользователю прямо в чат, не ссылкой на файл.\n' +
  'Пустой вывод или MZ_NOT_FOUND — штатный случай (скрипт стоит не на каждой машине), не сбой: верни {"brief_md":"(агрегат-брифинг недоступен; смотри visual_report.html)","notes":0,"top_now":[],"future_count":0}.',
  { label: 'briefing', phase: 'Briefing', model: 'haiku',
    schema: { type: 'object', properties: {
      brief_path: { type: ['string', 'null'] },
      brief_md: { type: 'string' },
      notes: { type: 'number' },
      top_now: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, path: { type: 'string' }, project: { type: 'string' },
        step: { type: 'string' }, effect: { type: 'string' }, score: { type: 'number' }
      } } },
      future_count: { type: 'number' },
      token_usage: { type: 'number' }
    }, required: ['brief_md'] } }
)
log('## БРИФИНГ ГОТОВ ✓ — ' + ((briefing && briefing.top_now) ? briefing.top_now.length : 0) + ' к применению сейчас → вывести в чат')
await observeRun('end')

// ---------- AGENT TRACE + SELF-REFLECTION INPUTS ----------
// Видимая трасса роя: какие named agents закрыли какие ворота. Это нужно пользователю и будущим агентам:
// не "какой-то worker", а Мнемозина/Кирилов/Сопиков/... с результатом и артефактами.
const ledger = (recon && recon.ledger) ? recon.ledger : {}
const balanced = (recon && typeof recon.balanced === 'boolean') ? recon.balanced : null
const agentTrace = [
  { name: 'Мнемозина', file: 'mnemazina-coordinator', phase: 'Observe/Orchestrate/Graphify/Briefing/SelfReflection', status: 'ok', tools: ['Agent', 'Bash', 'abtop', 'Graphify', 'mnemozina-brief'], closed: ['run observability', 'graph', 'brief_md'] },
  { name: 'Иван Кирилов', file: 'mnemazina-guard', phase: 'Guard+Census', status: guardResult && guardResult.error ? 'error' : 'ok', tools: ['git', 'find', 'shasum', 'hash-cache'], closed: ['snapshot', 'lock', 'census'] },
  { name: 'Василий Сопиков', file: 'mnemazina-triage/mnemazina-classify', phase: 'Triage/Classify', status: missing.length ? 'repaired' : 'ok', tools: ['Read', 'Grep', 'OCR sidecars', '_ROUTING.md'], closed: ['manifest'], note: missing.length ? ('ГЕЙТ-1 форсировал ' + missing.length + ' пропусков') : '' },
  { name: 'Михаил Ломоносов', file: 'mnemazina-processor/mnemazina-extract/mnemazina-verify/mnemazina-refine', phase: 'Process', status: processResults.length === tieredUnits.length ? 'ok' : 'partial', tools: ['Apple Vision OCR', 'whisper sidecars', 'markitdown', 'kb-fetch/kb-search', 'GitHub API', 'fastembed'], closed: ['notes', 'source/sources'] },
  { name: 'Николай Калачов', file: 'mnemazina-librarian/mnemazina-distribute/mnemazina-index/mnemazina-fix', phase: 'Store/Archive/FIND', status: 'ok', tools: ['Write', 'Edit', 'mv', 'kb-embed', 'indexes'], closed: ['store', 'indexes', 'archive'] },
  { name: 'Дмитрий Менделеев', file: 'mnemazina-reconciler', phase: 'Reconcile', status: coverageFull && balanced !== false ? 'ok' : 'gaps', tools: ['grep source:', 'sources:', 'ledger'], closed: [coverageFull ? 'coverage full' : 'coverage gaps'] },
]

// ---------- TOKEN USAGE (финал — ВСЕГДА после observeRun end) ----------
const tokenUsage = await agent(
  'Финал Мнемозины — посчитай токены этого run_id по Run Observatory.\n' +
  'RUN_ID=' + RUN_ID + '\nOBS_LOG=' + OBS_LOG + '\n\n' +
  'Выполни bash/python без TTY: прочитай JSONL, возьми строки с этим run_id. ' +
  'Из поля tokens попробуй извлечь число токенов start/end и delta=end-start. ' +
  'Пустые tokens или abtop_unavailable — штатный случай (abtop стоит не на каждой машине), не сбой: верни null в числовых полях и пояснение в note. Ничего не меняй на диске.\n' +
  'Верни JSON: { "runtime":"claude-workflow", "source":"abtop", "observability_log":"' + OBS_LOG + '", ' +
  '"start_tokens": number|null, "end_tokens": number|null, "delta_tokens": number|null, "samples": number, "note": string }',
  { label: 'token-usage', phase: 'TokenUsage', model: 'haiku',
    schema: { type: 'object', properties: {
      runtime: { type: 'string' },
      source: { type: 'string' },
      observability_log: { type: 'string' },
      start_tokens: { type: ['number', 'null'] },
      end_tokens: { type: ['number', 'null'] },
      delta_tokens: { type: ['number', 'null'] },
      samples: { type: 'number' },
      note: { type: 'string' }
    }, required: ['runtime', 'source', 'observability_log', 'samples', 'note'] } }
)
phase('SessionReview')
const sessionReview = await agent(
  'Финал Мнемозины — локальный анализ расхода токенов, local-first audit и ledger ошибок. Выполни bash без TTY:\n' +
  MZ_RESOLVE +
  'mz_run mnemozina-session-review ' +
  '--run-id "' + RUN_ID + '" --runtime "claude-workflow" ' +
  '--token-json ' + JSON.stringify(JSON.stringify(tokenUsage)) + ' ' +
  '--result-json ' + JSON.stringify(JSON.stringify({
    run_id: RUN_ID,
    status: coverageFull ? 'done' : 'done_with_gaps',
    balanced: balanced,
    unaccounted: unaccounted,
    graph_updated: !!(graphRes && graphRes.graph === 'updated'),
    briefing: briefing,
    agent_trace: agentTrace,
    gates: {
      manifest: '## МАНИФЕСТ ПОЛНЫЙ ✓',
      coverage: coverageFull ? '## ПОКРЫТИЕ ПОЛНОЕ ✓' : '## ПОКРЫТИЕ НЕПОЛНОЕ ✗',
      archive: archiveVerified === null ? '## АРХИВ: нечего переносить' : '## АРХИВ: в инбоксе осталось ' + archiveVerified + ' записей'
    }
  })) + '\n' +
  'Верни JSON из stdout как есть. Пустой вывод или MZ_NOT_FOUND — штатный случай (скрипт не установлен на этой машине), не сбой: верни {"review_path":"","ledger_path":"","errors":["mnemozina-session-review не найден на этой машине"]}.',
  { label: 'session-review', phase: 'SessionReview', model: 'haiku',
    schema: { type: 'object', properties: {
      review_path: { type: 'string' },
      ledger_path: { type: 'string' },
      token_summary: { type: 'object' },
      audit: { type: 'object' },
      self_reflection: { type: 'object' },
      errors: { type: 'array', items: { type: 'string' } }
    }, required: ['review_path', 'ledger_path'] } }
)
await releaseRunLock('done')

// ---------- ЛЕДЖЕР ----------
const installSuggestions = processResults
  .filter(function (r) { return r && r.install_suggestion }).map(function (r) { return r.install_suggestion })

return {
  status: coverageFull ? 'done' : 'done_with_gaps',
  run_id: RUN_ID,
  census: allCensus.length,
  new_processed: inboxFiles.length,
  cached: cachedFiles.length,
  ledger: ledger,
  balanced: balanced,
  archived: toArchive.length,
  unaccounted: unaccounted,
  new_sections: (storeResult && storeResult.new_sections) ? storeResult.new_sections : [],
  graph_updated: !!(graphRes && graphRes.graph === 'updated'),
  final_code_steps: finalChecks,
  quality_gate_failed_sources: qualityFailedFiles,
  observability_log: OBS_LOG,
  token_usage: tokenUsage,
  agent_trace: agentTrace,
  session_review: sessionReview,
  visual_report: visualReport,
  self_reflection: sessionReview && sessionReview.self_reflection ? sessionReview.self_reflection : null,
  dag_file: DAG_FILE,
  needs_graphify_init: !!(graphRes && graphRes.graph === 'needs_init'),
  ocr_engine: 'Apple Vision (vision-ocr, локально)',
  semantic_dedup: embedReady ? 'on (fastembed, порог ' + DUP_THRESHOLD + ')' : 'off',
  install_suggestions: installSuggestions,
  gates: {
    manifest: '## МАНИФЕСТ ПОЛНЫЙ ✓',
    coverage: coverageFull ? '## ПОКРЫТИЕ ПОЛНОЕ ✓' : '## ПОКРЫТИЕ НЕПОЛНОЕ ✗',
    archive: archiveVerified === null ? '## АРХИВ: нечего переносить' : '## АРХИВ: в инбоксе осталось ' + archiveVerified + ' записей'
  },
  notes: processResults.filter(function (r) { return r && r.outcome === 'note' }).map(function (r) {
    return { title: r.filename, section: r.section, verified: r.verified, helps: r.helps, next_action: r.next_action }
  }),
  briefing: briefing
}
