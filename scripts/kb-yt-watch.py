#!/usr/bin/env python3
"""kb-yt-watch — poll registered YouTube channels for new videos.

For each channel in ROOT/.mnemazine/cache/kb-yt/channels.json: read its RSS
feed (last 15 uploads), diff against the per-channel archive, and harvest only
the new ones via kb-yt-harvest.py (which dedups again through the same archive).
If anything new was harvested and study mode is on, run the Mnemazine pipeline
so the fresh drops are studied into the vault.

Meant to run from launchd / cron (daily). RSS is the cheap "anything new?"
signal — no scraping, no bot risk. Heavy work happens only on new videos.

Paths follow the Mnemazine convention (MNEMAZINE_ROOT / MNEMAZINE_INBOX).

Flags:
  --dry-run        report what would be harvested, do nothing
  --harvest-only   harvest new videos but do NOT run the study pipeline

Env:
  MNEMAZINE_STUDY_CMD   shell command to study the inbox after harvest
                        (default: node ROOT/scripts/mnemazine-run.mjs)
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("MNEMAZINE_ROOT") or Path(__file__).resolve().parent.parent)
STATE_DIR = ROOT / ".mnemazine" / "cache" / "kb-yt"
ARCHIVE_DIR = STATE_DIR / "archive"
CHANNELS_JSON = STATE_DIR / "channels.json"
HARVESTER = ROOT / "scripts" / "kb-yt-harvest.py"
WATCH_LIMIT = 15


def rss_video_ids(cid, n=WATCH_LIMIT):
    """Fetch the channel RSS via curl (system certs — framework-python urllib
    fails on SSL cert verification on macOS). Return newest video IDs."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
    r = subprocess.run(["curl", "-sS", "--max-time", "20", url],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  RSS error {cid}: {r.stderr.strip()[:120]}", file=sys.stderr)
        return []
    return re.findall(r"<yt:videoId>([^<]+)</yt:videoId>", r.stdout)[:n]


def archived_ids(cid):
    f = ARCHIVE_DIR / f"{cid}.txt"
    if not f.exists():
        return set()
    out = set()
    for ln in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = ln.split()
        if parts:
            out.add(parts[-1])
    return out


def study_inbox():
    cmd = os.environ.get("MNEMAZINE_STUDY_CMD")
    if cmd:
        print(f"new videos harvested -> {cmd}")
        subprocess.run(cmd, shell=True)
    else:
        runner = ROOT / "scripts" / "mnemazine-run.mjs"
        print(f"new videos harvested -> node {runner}")
        subprocess.run(["node", str(runner)])


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    study = "--harvest-only" not in args

    if not CHANNELS_JSON.exists():
        print("no channels registered")
        return 0
    channels = json.loads(CHANNELS_JSON.read_text(encoding="utf-8"))

    any_new = False
    for ch in channels:
        cid, url, handle = ch["channel_id"], ch["url"], ch.get("handle", "?")
        top = rss_video_ids(cid)
        have = archived_ids(cid)
        fresh = [v for v in top if v not in have]
        if not fresh:
            print(f"{handle}: no new")
            continue
        if dry:
            print(f"{handle}: would harvest {len(fresh)} new (rss={len(top)} archived={len(have)})")
            continue
        print(f"{handle}: {len(fresh)} new -> harvest")
        subprocess.run([sys.executable, str(HARVESTER), url, "--limit", str(WATCH_LIMIT)])
        any_new = True

    if dry:
        print("(dry-run, nothing harvested)")
        return 0
    if not any_new:
        print("nothing new across all channels")
        return 0
    if study:
        study_inbox()
    else:
        print("new videos harvested (harvest-only; run the pipeline when ready)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
