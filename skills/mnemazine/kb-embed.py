#!/usr/bin/env python3
"""kb-embed — локальный семантический индекс vault для дедупа Мнемозины.

Без Ollama/облака: fastembed (onnxruntime) + multilingual-MiniLM, CPU.
Ловит смысловые дубли, которые hash-cache (байтовый) пропускает —
пере-скриншот/пере-сейв того же знания с другим хэшем.

Запуск через venv: ~/.venvs/kb-embed/bin/python kb-embed.py <cmd> ...

Команды:
  build  <vault> <out.json>                 — эмбеддит все ноты → индекс
  add    <out.json> <note.md> [note.md...]  — дозаписать ноты в индекс
  query  <idx.json> <text> [topk] [thr]     — топ-похожих + зона merge/flag/new
                                              (первая строка text считается заголовком)
  rerank <idx.json> <text> [topk]           — top-30 cosine → кросс-энкодер → top-k
  pairs  <idx.json> <note.md> [note.md...]  — попарные cosine внутри списка
                                              (дедуп свежего батча, слепого к индексу)

Все ответы — одна строка JSON (для парсинга агентом).
"""
import sys
import os
import re
import json
import glob
import math
import warnings

warnings.filterwarnings("ignore")  # чистый JSON-выхлоп для парсинга агентом

MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"  # 384d, ~220MB, мультиязык RU
MAX_CHARS = 2000                          # хвост ноты не нужен для темы

# Пороги зон/заголовков подобраны замером на корпусе vault 2026-07-25
# (кластер Camofox ×4 в «08 AI и Инструменты»); при смене MODEL перекалибровать замером.
ZONE_MERGE = 0.90       # combined ≥ — кандидат на слияние (вердикт всё равно за судьёй)
ZONE_FLAG = 0.72        # combined ≥ — показать на ревью; ниже — законная новая нота
TITLE_WEIGHT = 0.3      # вклад совпадения заголовков в combined
TITLE_SIM_MIN = 0.5     # ниже — заголовки несвязаны, вклад 0 (не топить cosine шумом)
RERANK_MODEL = "jinaai/jina-reranker-v2-base-multilingual"  # единственный RU-способный в fastembed 0.8
RERANK_POOL = 30        # сколько cosine-кандидатов уходит в кросс-энкодер
RERANK_DOC_CHARS = 1000  # документ для кросс-энкодера: дальше 1000 симв — обрезка токенайзером
LEX_DOC_CHARS = 400     # fallback-реранк смотрит заголовок + первые 400 симв тела
LEX_STEM = 5            # псевдо-лемма = первые 5 симв токена (грубая замена стеммера, stdlib-only)


def _emb(texts, prefix):
    from fastembed import TextEmbedding
    model = TextEmbedding(MODEL)
    return [v.tolist() for v in model.embed([prefix + t for t in texts])]


def _strip_fm(text):
    """Убрать YAML-frontmatter, оставить тело."""
    t = text
    if t.startswith("---"):
        end = t.find("\n---", 3)
        if end != -1:
            t = t[end + 4:]
    return t.strip()


def _is_content_note(p):
    bad = ("/graphify-out/", "/.git/", "/.obsidian/")
    if any(b in p for b in bad):
        return False
    # сегмент с "_" — служебная плоскость (_archive, _lint, _digest): дубль с уже
    # архивированной нотой — не находка, а шум, поэтому режем весь путь, не только basename
    return not any(seg.startswith("_") for seg in p.split(os.sep))


def _read_body(p):
    try:
        return _strip_fm(open(p, encoding="utf-8").read())[:MAX_CHARS]
    except Exception:
        return ""


def _cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def _title(p):
    """Заголовок ноты из имени файла: без даты-префикса и расширения."""
    t = os.path.splitext(os.path.basename(p))[0]
    return re.sub(r"^\d{4}-\d{2}-\d{2}\s*[—–-]\s*", "", t)


def _tokens(s):
    s = s.lower().replace("ё", "е")
    return {w for w in re.findall(r"[a-zа-я0-9]+", s) if len(w) >= 2}


def _title_sim(a, b):
    """Containment по токенам, не SequenceMatcher: перестановка слов не штрафуется."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


def _combined(cos, tsim):
    boost = TITLE_WEIGHT * tsim if tsim >= TITLE_SIM_MIN else 0.0
    return min(1.0, cos + boost)


def _zone(c):
    return "merge" if c >= ZONE_MERGE else "flag" if c >= ZONE_FLAG else "new"


def cmd_build(vault, out):
    notes = [p for p in glob.glob(vault + "/**/*.md", recursive=True) if _is_content_note(p)]
    bodies = [_read_body(p) for p in notes]
    pairs = [(p, b) for p, b in zip(notes, bodies) if b]
    vecs = _emb([b for _, b in pairs], "") if pairs else []
    idx = {p: v for (p, _), v in zip(pairs, vecs)}
    json.dump(idx, open(out, "w"), ensure_ascii=False)
    print(json.dumps({"indexed": len(idx), "out": out}))


def cmd_add(out, notes):
    idx = json.load(open(out)) if os.path.exists(out) else {}
    bodies = [_read_body(p) for p in notes]
    pairs = [(p, b) for p, b in zip(notes, bodies) if b]
    if pairs:
        vecs = _emb([b for _, b in pairs], "")
        for (p, _), v in zip(pairs, vecs):
            idx[p] = v
    json.dump(idx, open(out, "w"), ensure_ascii=False)
    print(json.dumps({"added": len(pairs), "total": len(idx)}))


def cmd_query(idxfile, text, topk=3, thr=0.0):
    idx = json.load(open(idxfile)) if os.path.exists(idxfile) else {}
    if not idx:
        print(json.dumps({"matches": [], "top": 0.0, "note": "index empty"}))
        return
    qtitle = text.strip().splitlines()[0] if text.strip() else ""
    qv = _emb([text[:MAX_CHARS]], "")[0]
    scored = []
    for p, v in idx.items():
        cos = _cos(qv, v)
        tsim = _title_sim(qtitle, _title(p))
        scored.append((_combined(cos, tsim), cos, tsim, p))
    scored.sort(reverse=True)
    matches = [{"note": p, "score": round(cos, 4), "title_sim": round(tsim, 4),
                "combined": round(comb, 4), "zone": _zone(comb)}
               for comb, cos, tsim, p in scored[:topk] if cos >= thr]
    top = max(cos for _, cos, _, _ in scored)  # top остаётся чистым cosine — старые вызовы его парсят
    print(json.dumps({"matches": matches, "top": round(top, 4)}, ensure_ascii=False))


def _lex_score(query, doc):
    qs = {w[:LEX_STEM] for w in _tokens(query)}
    ds = {w[:LEX_STEM] for w in _tokens(doc)}
    return len(qs & ds) / len(qs) if qs else 0.0


def cmd_rerank(idxfile, text, topk=5):
    idx = json.load(open(idxfile)) if os.path.exists(idxfile) else {}
    if not idx:
        print(json.dumps({"matches": [], "reranker": None, "note": "index empty"}))
        return
    qv = _emb([text[:MAX_CHARS]], "")[0]
    pool = sorted(((_cos(qv, v), p) for p, v in idx.items()), reverse=True)[:RERANK_POOL]
    docs = [_title(p) + "\n" + _read_body(p)[:RERANK_DOC_CHARS] for _, p in pool]
    try:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        scores = list(TextCrossEncoder(RERANK_MODEL).rerank(text, docs))
        method = "cross-encoder:" + RERANK_MODEL
    except ImportError:
        # старый fastembed без TextCrossEncoder; псевдо-леммы, качество ниже кросс-энкодера
        scores = [_lex_score(text, d[:len(_title(p)) + 1 + LEX_DOC_CHARS])
                  for d, (_, p) in zip(docs, pool)]
        method = "lexical-fallback"
    ranked = sorted(zip(scores, pool), key=lambda x: x[0], reverse=True)[:topk]
    matches = [{"note": p, "cosine": round(cos, 4), "rerank": round(float(s), 4)}
               for s, (cos, p) in ranked]
    print(json.dumps({"matches": matches, "reranker": method, "pool": len(pool)},
                     ensure_ascii=False))


def cmd_pairs(idxfile, notes):
    # idx-аргумент — для единообразия CLI; вектора всегда свежие с диска,
    # потому что кэш индекса протухает после правки ноты
    read = [(p, _read_body(p)) for p in notes]
    unreadable = [p for p, b in read if not b]
    alive = [(p, b) for p, b in read if b]
    if len(alive) < 2:
        print(json.dumps({"error": "pairs needs >=2 readable notes",
                          "unreadable": unreadable}, ensure_ascii=False))
        sys.exit(1)
    vecs = _emb([b for _, b in alive], "")
    out = []
    for i in range(len(alive)):
        for j in range(i + 1, len(alive)):
            cos = _cos(vecs[i], vecs[j])
            tsim = _title_sim(_title(alive[i][0]), _title(alive[j][0]))
            comb = _combined(cos, tsim)
            out.append({"a": alive[i][0], "b": alive[j][0], "score": round(cos, 4),
                        "title_sim": round(tsim, 4), "combined": round(comb, 4),
                        "zone": _zone(comb)})
    out.sort(key=lambda r: -r["combined"])
    print(json.dumps({"pairs": out, "n": len(alive), "unreadable": unreadable},
                     ensure_ascii=False))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: build|add|query|rerank|pairs"}))
        sys.exit(1)
    cmd = sys.argv[1]
    try:
        if cmd == "build":
            cmd_build(sys.argv[2], sys.argv[3])
        elif cmd == "add":
            cmd_add(sys.argv[2], sys.argv[3:])
        elif cmd == "query":
            topk = int(sys.argv[4]) if len(sys.argv) > 4 else 3
            thr = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
            cmd_query(sys.argv[2], sys.argv[3], topk, thr)
        elif cmd == "rerank":
            topk = int(sys.argv[4]) if len(sys.argv) > 4 else 5
            cmd_rerank(sys.argv[2], sys.argv[3], topk)
        elif cmd == "pairs":
            cmd_pairs(sys.argv[2], sys.argv[3:])
        else:
            print(json.dumps({"error": "unknown cmd: " + cmd}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
