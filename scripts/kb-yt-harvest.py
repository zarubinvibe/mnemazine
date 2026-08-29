#!/usr/bin/env python3
"""kb-yt-harvest — YouTube channel/video harvester for Mnemazine.

Enumerate a channel (or take a single video), pull the transcript
(subtitles first, local whisper fallback), and drop one Markdown note per
video into the Mnemazine inbox for the refinement pipeline to study.

Dedup via a per-channel yt-dlp download-archive file: a video is harvested
once, whether caught by the initial backfill or the RSS watch loop.

Pure CLI under the hood (yt-dlp + whisper + ffmpeg) — no model tokens spent here.

Paths follow the Mnemazine convention (see scripts/mnemazine-run.mjs):
  MNEMAZINE_ROOT   repo root      (default: this script's repo)
  MNEMAZINE_INBOX  inbox dir      (default: ROOT/inbox)
  state            ROOT/.mnemazine/cache/kb-yt/   (gitignored)

Notes land at the inbox top level (the pipeline census is non-recursive),
named yt_<upload_date>_<video_id>_<title>.md.

Usage:
  kb-yt-harvest.py <channel-or-video-url> [--limit N | --all] [--subscribe] [--out DIR]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("MNEMAZINE_ROOT") or Path(__file__).resolve().parent.parent)
INBOX = Path(os.environ.get("MNEMAZINE_INBOX") or ROOT / "inbox")
STATE_DIR = ROOT / ".mnemazine" / "cache" / "kb-yt"
ARCHIVE_DIR = STATE_DIR / "archive"
CHANNELS_JSON = STATE_DIR / "channels.json"
DEFAULT_BACKFILL_CAP = 50
SUB_LANGS = "ru,en"
NET = ["--retries", "2", "--socket-timeout", "15"]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def ensure_dirs():
    for d in (STATE_DIR, ARCHIVE_DIR):
        d.mkdir(parents=True, exist_ok=True)


def slugify(s):
    s = re.sub(r"[^\w\-]+", "_", (s or "").strip(), flags=re.UNICODE)
    return re.sub(r"_+", "_", s).strip("_")[:60] or "video"


def normalize_url(url):
    """Append /videos to a bare channel URL so we enumerate uploads, not tabs."""
    if any(k in url for k in ("watch?v=", "/shorts/", "list=")):
        return url
    if re.search(r"/(@[\w.\-]+|channel/[\w\-]+|c/[\w\-]+|user/[\w\-]+)/?$", url):
        return url.rstrip("/") + "/videos"
    return url


def channel_meta_from_video(url):
    """Resolve (channel_id, channel_slug) via a full extract of one video.
    Flat-playlist entries lack channel_id/uploader_id, so we ask a real video —
    one request, and it reliably carries channel_id (required for the RSS feed)."""
    r = run(["yt-dlp", "--skip-download", "--no-warnings",
             "--print", "%(channel_id)s\t%(channel)s", *NET, url])
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
    if not lines:
        return None, "channel"
    p = lines[0].split("\t")
    cid = p[0] if p and p[0] not in ("", "NA") else None
    name = p[1] if len(p) > 1 and p[1] not in ("", "NA") else "channel"
    return cid, slugify(name)


def read_upload_date(wd):
    """Read upload_date captured via yt-dlp --print-to-file during fetch (0 extra requests).
    The subtitle path does not emit info.json, so a dedicated sidecar is the reliable source."""
    f = wd / "upload_date.txt"
    if f.exists():
        d = f.read_text(encoding="utf-8", errors="ignore").strip()
        if re.fullmatch(r"\d{8}", d):
            return d
    return ""


def enumerate_videos(url, cap=None):
    """List videos as dicts (id, title, upload_date, url). Channel order = newest first."""
    cmd = ["yt-dlp", "--flat-playlist",
           "--print", "%(id)s\t%(title)s\t%(upload_date)s", *NET]
    if cap:
        cmd += ["--playlist-end", str(cap)]
    cmd.append(url)
    r = run(cmd)
    vids = []
    for ln in (r.stdout or "").splitlines():
        p = ln.split("\t")
        if p and p[0]:
            vids.append({
                "id": p[0],
                "title": p[1] if len(p) > 1 and p[1] else p[0],
                "upload_date": p[2] if len(p) > 2 and p[2] != "NA" else "",
                "url": f"https://www.youtube.com/watch?v={p[0]}",
            })
    return vids


def already_done(archive_file, vid_id):
    if not archive_file.exists():
        return False
    return f"youtube {vid_id}" in archive_file.read_text(encoding="utf-8", errors="ignore")


def mark_done(archive_file, vid_id):
    archive_file.parent.mkdir(parents=True, exist_ok=True)
    with archive_file.open("a", encoding="utf-8") as f:
        f.write(f"youtube {vid_id}\n")


def vtt_to_text(vtt):
    """Strip WEBVTT structure + inline tags, dedup consecutive lines (auto-subs repeat)."""
    out = []
    for ln in vtt.splitlines():
        ln = ln.strip()
        if not ln or ln == "WEBVTT" or "-->" in ln:
            continue
        if re.match(r"^\d+$", ln) or ln.startswith(("Kind:", "Language:", "NOTE")):
            continue
        ln = re.sub(r"<[^>]+>", "", ln)
        ln = re.sub(r"\s*(align|position):\S+", "", ln).strip()
        if ln and (not out or out[-1] != ln):
            out.append(ln)
    return "\n".join(out).strip() or None


def fetch_subtitles(vid_url, wd):
    """Download subtitles, pick best track (ru>en, manual>auto). Return text or None."""
    base = str(wd / "sub")
    run(["yt-dlp", "--skip-download", "--write-subs", "--write-auto-subs",
         "--print-to-file", "%(upload_date)s", str(wd / "upload_date.txt"),
         "--sub-langs", SUB_LANGS, "--sub-format", "vtt", *NET,
         "-o", base + ".%(ext)s", vid_url])
    cands = list(wd.glob("sub*.vtt"))
    if not cands:
        return None

    def score(p):
        n = p.name
        s = 0
        if ".ru" in n:
            s -= 4
        if ".en" in n:
            s -= 2
        if "auto" in n or "-orig" in n:
            s += 1
        return s

    best = sorted(cands, key=score)[0]
    return vtt_to_text(best.read_text(encoding="utf-8", errors="ignore"))


def fetch_whisper(vid_url, wd):
    """Fallback: download audio, transcribe with local whisper. Return text or None."""
    run(["yt-dlp", "-f", "bestaudio", "-x", "--audio-format", "mp3",
         "--print-to-file", "%(upload_date)s", str(wd / "upload_date.txt"),
         *NET, "-o", str(wd / "audio.%(ext)s"), vid_url])
    audio = [a for a in wd.glob("audio.*")
             if a.suffix.lower() in (".mp3", ".m4a", ".webm", ".opus", ".wav", ".aac")]
    if not audio:
        return None
    run(["whisper", str(audio[0]), "--model", "small",
         "--output_format", "txt", "--output_dir", str(wd)])
    txts = [t for t in wd.glob("*.txt") if t.name != "upload_date.txt"]
    if not txts:
        return None
    return txts[0].read_text(encoding="utf-8", errors="ignore").strip() or None


def write_note(inbox, channel, vid, text, method):
    inbox.mkdir(parents=True, exist_ok=True)
    date = vid["upload_date"] or "00000000"
    fpath = inbox / f"yt_{date}_{vid['id']}_{slugify(vid['title'])}.md"
    title = vid["title"].replace("\n", " ")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    note = (
        "---\n"
        f"source: {vid['url']}\n"
        f"channel: {channel}\n"
        f"video_id: {vid['id']}\n"
        f"title: {title}\n"
        f"upload_date: {date}\n"
        f"transcript_method: {method}\n"
        f"harvested: {now}\n"
        "type: youtube-transcript\n"
        "---\n\n"
        f"# {title}\n\n{vid['url']}\n\n{text}\n"
    )
    fpath.write_text(note, encoding="utf-8")
    return fpath


def register_channel(cid, handle, url):
    data = []
    if CHANNELS_JSON.exists():
        data = json.loads(CHANNELS_JSON.read_text(encoding="utf-8"))
    if any(c.get("channel_id") == cid for c in data):
        return
    data.append({
        "channel_id": cid,
        "handle": handle,
        "url": url,
        "rss": f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}",
        "added": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    })
    CHANNELS_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"registered for RSS watch: {handle} ({cid})")


def harvest(url, inbox, cap, subscribe):
    ensure_dirs()
    url = normalize_url(url)
    vids = enumerate_videos(url, cap=cap)
    if not vids:
        print("ERROR: no videos found / could not enumerate", file=sys.stderr)
        return 1
    cid, handle = channel_meta_from_video(vids[0]["url"])
    archive_file = ARCHIVE_DIR / f"{cid or handle}.txt"
    print(f"channel={handle} id={cid} listed={len(vids)} cap={cap or 'ALL'} inbox={inbox}")

    done = skipped = failed = 0
    for v in vids:
        if already_done(archive_file, v["id"]):
            skipped += 1
            continue
        with tempfile.TemporaryDirectory() as td:
            wd = Path(td)
            text, method = fetch_subtitles(v["url"], wd), "subtitles"
            if not text:
                text, method = fetch_whisper(v["url"], wd), "whisper"
            if not text:
                failed += 1
                print(f"  FAIL {v['id']} {v['title'][:48]}")
                continue
            if not v["upload_date"]:
                v["upload_date"] = read_upload_date(wd)
            p = write_note(inbox, handle, v, text, method)
            mark_done(archive_file, v["id"])
            done += 1
            print(f"  OK [{method}] {v['id']} -> {p.name}")

    if subscribe and cid:
        register_channel(cid, handle, url)
    print(f"DONE harvested={done} skipped={skipped} failed={failed} inbox={inbox}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="YouTube harvester for Mnemazine")
    ap.add_argument("url", help="channel URL (@handle / channel/ / c/ / user/) or a single video URL")
    ap.add_argument("--out", default=str(INBOX), help="inbox dir (default: $MNEMAZINE_INBOX or ROOT/inbox)")
    ap.add_argument("--limit", type=int, default=None, help="cap N newest videos (backfill guard)")
    ap.add_argument("--all", action="store_true", help="full backfill (override default cap of 50)")
    ap.add_argument("--subscribe", action="store_true", help="register channel for RSS watch")
    a = ap.parse_args()
    cap = None if a.all else (a.limit if a.limit is not None else DEFAULT_BACKFILL_CAP)
    sys.exit(harvest(a.url, Path(a.out).expanduser(), cap, a.subscribe))


if __name__ == "__main__":
    main()
