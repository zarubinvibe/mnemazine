#!/usr/bin/env python3
"""kb-search "<query>" [--ru] [--max N] — метапоиск без ключей → JSON-массив в stdout.

Ярусы 3–4 цепочки поиска Мнемозины (первый ярус — встроенный WebSearch агента, он
бесплатен и зовется напрямую; этот скрипт нужен, когда WebSearch пуст или пайплайн
работает вне харнесса). Внутри ddgs: brave → duckduckgo → mojeek → startpage; --ru
добавляет yandex последним, потому что рунет он индексирует лучше всех, но и банит
агрессивнее всех. Дисциплина: пауза 2с между бэкендами, один провал = следующий
бэкенд, все провалились = exit 1 с честным «поиск деградировал» (это не ошибка
скрипта — модель помечает факт как непроверенный, не выдумывает выдачу).
"""
import json
import os
import subprocess
import sys
import tempfile
import time

DDGS = os.environ.get("MNEMAZINE_DDGS_BIN", "ddgs")
BACKENDS = ["brave", "duckduckgo", "mojeek", "startpage"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: kb-search \"<query>\" [--ru] [--max N]", file=sys.stderr)
        sys.exit(1)
    query = args[0]
    ru = "--ru" in sys.argv
    max_n = 10
    if "--max" in sys.argv:
        max_n = int(sys.argv[sys.argv.index("--max") + 1])

    backends = BACKENDS + (["yandex"] if ru else [])
    region = "ru-ru" if ru else "us-en"
    errors = []
    for i, b in enumerate(backends):
        if i:
            time.sleep(2)
        try:
            # ddgs пишет только в файл — /dev/stdout ломает его click-обвязку
            tmp = tempfile.mktemp(suffix=".json")
            subprocess.run(
                [DDGS, "text", "-q", query, "-m", str(max_n), "-b", b, "-r", region,
                 "-o", tmp, "-nc"],
                capture_output=True, text=True, timeout=40)
            if not os.path.exists(tmp):
                errors.append(f"{b}: файл выдачи не создан")
                continue
            rows = json.load(open(tmp))
            os.unlink(tmp)
            if rows:
                print(json.dumps(
                    [{"title": x.get("title", ""), "url": x.get("href", ""),
                      "snippet": x.get("body", ""), "engine": b} for x in rows],
                    ensure_ascii=False))
                return
            errors.append(f"{b}: 0 результатов")
        except Exception as e:
            errors.append(f"{b}: {e}")
    print(json.dumps({"ok": False, "reason": "поиск деградировал: " + "; ".join(errors)},
                     ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
