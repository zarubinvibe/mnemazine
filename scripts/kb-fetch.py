#!/usr/bin/env python3
"""kb-fetch <url> [--allow-remote] [--timeout N] — один URL → один JSON в stdout.

Бесплатный каскад скрейпа Мнемозины (решение 2026-07-25, docs/PLAN + scrape-decision):
  ярус 0  markitdown  — бинарники (pdf/docx/pptx/xlsx) и медиа-домены → стадия 0
  ярус 1  trafilatura — статический HTML (~80% случаев), русский проверен живьём
  ярус 2  needs_js    — exit 2: агент сам эскалирует на Playwright MCP / WebFetch
  remote  Jina Reader — ТОЛЬКО с --allow-remote и только публичное: квотный тариф,
          по правилу владельца это категория «платно», в автоматику не входит.
Exit: 0 годный текст · 2 пусто/нужен JS · 3 заблокировано · 4 сеть/таймаут.
Правило модели: ok=false → не выдумывать содержимое, пометить «источник недоступен».
"""
import json
import os
import ssl
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import certifi

# ponytail: trafilatura живёт в venv kb-web и не лежит на PATH — берём его напрямую,
# фолбэк на PATH оставлен для чужих машин
TRAFILATURA = os.environ.get(
    "MNEMAZINE_TRAFILATURA_BIN",
    next((c for c in (os.path.expanduser("~/.venvs/kb-web/bin/trafilatura"),)
          if os.path.exists(c)), "trafilatura"),
)

SSL_CTX = ssl.create_default_context(cafile=certifi.where())  # venv-python macOS без системных корней

MEDIA_HOSTS = ("youtube.com", "youtu.be", "vimeo.com", "rutube.ru", "vk.com/video")
BINARY_EXT = (".pdf", ".docx", ".pptx", ".xlsx", ".epub")
CHALLENGE = ("Just a moment", "Checking your browser", "Проверка браузера", "cf-chl",
             "Enable JavaScript and cookies")
MIN_CHARS = 400          # ponytail: порог «годного» текста; крутить по опыту прогонов
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"


def out(obj, code):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def result(url, ok, tool, tier, md, reason=""):
    return {"ok": ok, "url": url, "tool": tool, "tier": tier, "reason": reason,
            "lang": "ru" if cyr_share(md) > 0.5 else "", "chars": len(md),
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "markdown": md}


def cyr_share(text):
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if "Ѐ" <= c <= "ӿ") / len(letters)


def mojibake(text):
    return any(m in text for m in ("Ð", "Ñ\x83", "�"))


def boiler_ratio(text):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < 8:
        return 0.0
    return 1 - len(set(lines)) / len(lines)


def fetch_html(url, timeout):
    # кириллица в пути/квери валит urllib ascii-кодеком — percent-кодируем всё вне ASCII
    url = urllib.parse.quote(url, safe=":/?&=#%+@;,$!*'()[]~-._")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        raw = r.read()
        ctype = r.headers.get("Content-Type", "")
        final = r.geturl()
    # charset живёт в HTTP-заголовке (легаси-рунет: koi8-r/1251 без <meta>) — из файла его
    # не восстановить, поэтому нормализуем в utf-8 здесь, до экстракции
    charset = ""
    if "charset=" in ctype.lower():
        charset = ctype.lower().split("charset=")[1].split(";")[0].strip()
    if charset and charset not in ("utf-8", "utf8"):
        try:
            text = raw.decode(charset, errors="replace")
            raw = text.encode("utf-8")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
        if mojibake(text) and cyr_share(text) < 0.15:
            try:
                text = raw.decode("windows-1251", errors="replace")
                raw = text.encode("utf-8")
            except Exception:
                pass
    return raw, text, ctype, final


def run_trafilatura(raw):
    # HTML подаётся в stdin (флаг -i ждёт СПИСОК URL-ов, не документ); байты уже
    # нормализованы в utf-8 по HTTP-charset в fetch_html
    r = subprocess.run([TRAFILATURA, "--output-format", "markdown"], input=raw,
                       capture_output=True, timeout=60)
    return (r.stdout or b"").decode("utf-8", errors="replace")


def run_markitdown(target, timeout=120):
    # URL скачиваем сами (у markitdown свой fetch без наших сертификатов/UA), файл отдаём как есть
    if target.startswith("http"):
        req = urllib.request.Request(target, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            data = r.read()
        suffix = "." + target.split("?")[0].rstrip("/").split(".")[-1][:5]
        if "/" in suffix or len(suffix) < 3:
            suffix = ".bin"
        with tempfile.NamedTemporaryFile("wb", suffix=suffix, delete=False) as f:
            f.write(data)
            target = f.name
    r = subprocess.run(["markitdown", target], capture_output=True, text=True, timeout=timeout)
    return r.stdout or ""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: kb-fetch <url> [--allow-remote] [--timeout N]", file=sys.stderr)
        sys.exit(4)
    url = args[0]
    allow_remote = "--allow-remote" in sys.argv
    timeout = 30
    if "--timeout" in sys.argv:
        timeout = int(sys.argv[sys.argv.index("--timeout") + 1])

    low = url.lower()
    if any(h in low for h in MEDIA_HOSTS):
        out(result(url, False, "yt-dlp", 0, "", "media: гони через стадию 0 (transcribe)"), 2)
    if any(low.split("?")[0].endswith(e) for e in BINARY_EXT):
        try:
            md = run_markitdown(url)
        except Exception as e:
            out(result(url, False, "markitdown", 0, "", f"markitdown: {e}"), 4)
        code = 0 if len(md) >= MIN_CHARS else 2
        out(result(url, code == 0, "markitdown", 0, md, "" if code == 0 else "пустой конверт"), code)

    try:
        raw, html, ctype, final = fetch_html(url, timeout)
    except urllib.error.HTTPError as e:
        code = 3 if e.code in (401, 403, 429, 451) else 4
        out(result(url, False, "curl", 1, "", f"http {e.code}"), code)
    except Exception as e:
        out(result(url, False, "curl", 1, "", f"сеть: {e}"), 4)

    if "text/html" not in ctype and ctype:
        md = run_markitdown(url)
        code = 0 if len(md) >= MIN_CHARS else 2
        out(result(url, code == 0, "markitdown", 0, md, ctype if code else "пустой конверт"), code)

    if any(m in html[:5000] for m in CHALLENGE):
        if allow_remote:
            try:  # Jina — чужой IP снимает challenge; квотная категория, только явный флаг
                _, md, _, _ = fetch_html("https://r.jina.ai/" + url, max(timeout, 60))
                if len(md) >= MIN_CHARS and not any(m in md for m in CHALLENGE):
                    out(result(url, True, "jina", 3, md, "remote-quota"), 0)
            except Exception:
                pass
        out(result(url, False, "curl", 1, "", "challenge/cloudflare"), 3)

    md = run_trafilatura(raw)
    # два голоса: страница богата таблицами, а экстракт их срезал → добрать markitdown
    if html.count("<table") > 3 and "|---" not in md:
        md2 = run_markitdown(url)
        if len(md2) > len(md):
            md = md2
            tool = "markitdown"
        else:
            tool = "trafilatura"
    else:
        tool = "trafilatura"

    ru_domain = any(t in low for t in (".ru/", ".xn--p1ai", ".su/")) or low.endswith((".ru", ".su"))
    if md and ru_domain and cyr_share(md) < 0.15:
        out(result(url, False, tool, 1, "", "кириллица <15% на ru-домене — битая экстракция"), 2)
    if md and (mojibake(md) or boiler_ratio(md) > 0.4):
        out(result(url, False, tool, 1, "", "мохибейк/boilerplate"), 2)
    if len(md) < MIN_CHARS:
        out(result(url, False, tool, 1, "", "needs_js: мало текста — эскалируй на Playwright MCP/WebFetch"), 2)
    out(result(url, True, tool, 1, md), 0)


if __name__ == "__main__":
    main()
