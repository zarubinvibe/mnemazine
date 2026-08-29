#!/usr/bin/env python3
"""
graphify_clean.py — durable post-processor for the Мнемозина knowledge graph.

Problem it solves
------------------
kb-refine notes share a fixed card template ("🎯 Как это поможет мне",
"Когда использовать", "Связанные темы", "Достоверность", ...). graphify's
semantic extractor emits every one of those section headers as its own node.
On the 2026-06-04 audit those template fields were ~39% of all nodes (1046 of
2873) and, because the same label appears in almost every note, they collapse
into false mega-hubs that glue unrelated domains together — hiding the real
connectivity of the graph.

This script runs AFTER `graphify ... --update` (or a full build) and cleans the
final graph.json deterministically — no LLM, no tokens. It is idempotent: run it
as many times as you like. Because it operates on the final merged graph, it also
neutralises the semantic-cache re-injection problem (templates that the cache
keeps re-adding are stripped on every pass).

What it does
------------
1. Back up graph.json -> .graph_preclean.json
2. Drop template/structural nodes (curated blocklist + structural substrings),
   never touching file_type == "code".
3. Merge duplicate concept nodes by normalized label (collapse "Юнит-экономика"
   that appears in 3 files into one node, rewiring edges) — this is what restores
   real cross-note connectivity.
4. Drop self-loops, recluster, auto-label communities by their top-degree member.
5. Rewrite graph.json (+ .graphify_labels.json), regenerate GRAPH_REPORT.md and
   graph.html.
6. Print a before/after ledger AND surface any *new* high-frequency non-code label
   that is NOT yet in the blocklist, so a freshly-added template field gets flagged
   for review instead of silently inflating the graph.

Why a curated blocklist (not blind frequency)
----------------------------------------------
A blind "drop anything appearing >= N times" rule would, as the vault grows,
eventually nuke genuine recurring concepts ("Claude Code", "Agent OS"). So the
drop set is an explicit, reviewed list of kb-refine card fields. Frequency is used
only to *surface candidates* for human review (--review), never to auto-drop.

Usage
-----
    python3 graphify_clean.py                     # clean the vault graph (default path)
    python3 graphify_clean.py /path/to/graph.json # clean a specific graph
    python3 graphify_clean.py --review            # also list freq>=THRESHOLD labels not blocklisted
    python3 graphify_clean.py --no-viz            # skip graph.html regeneration

Run it right after every graphify build/update of the Мнемозина vault.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Override with MNEMAZINE_VAULT or pass the graph path.
_VAULT = Path(os.environ.get("MNEMAZINE_VAULT") or (Path(__file__).resolve().parents[1] / "vault"))
DEFAULT_GRAPH = str(_VAULT / "graphify-out" / "graph.json")

# --- curated kb-refine card template fields (normalized: lowercased, ws-collapsed) ---
# These are SECTION HEADERS, not knowledge. Reviewed from the 2026-06-04 audit.
TEMPLATE_LABELS = {
    "как это поможет мне", "🎯 как это поможет мне",
    "когда использовать", "связанные темы", "связанные заметки",
    "что это и зачем", "что это",
    "достоверность", "достоверность и границы", "границы достоверности",
    "описание конечного результата",
    "чек-лист качества", "проверочный чек-лист", "проверка",
    "тип материала", "плейсхолдеры",
    "суть / как работает", "извлеченная суть", "извлеченная суть",
    "что было лишним или слабым", "что было слабым",
    "улучшенная версия", "готовая версия", "готовая версия (установка)",
    "что полезного в исходнике", "что улучшено",
    "как применять", "универсальный шаблон", "универсальный prompt",
    "источник", "источники", "источники внутри папки", "источники из пачки",
    "официальные источники",
    "установка", "быстрый старт", "риски", "ограничения", "контекст", "зачем",
    "важная оговорка", "короткий вывод", "итог", "вывод", "резюме", "название",
    "что уже зафиксировано",
    "два чек-листа полноты", "два обязательных чек-листа полноты",
    "источники и опорные документы", "источники и референсы",
}

# structural / self-ingested files (substring match on normalized label)
STRUCTURAL_SUBSTR = (
    "содержание", "оглавление", "мастер-индекс", "_community",
    "лог обработки", "code:json",
)

# frequency threshold used ONLY to surface review candidates (never auto-drop)
REVIEW_FREQ = 4


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s).strip().lower())


def load_graph(path: Path):
    from networkx.readwrite import json_graph

    data = json.loads(path.read_text())
    return json_graph.node_link_graph(data, edges="links")


def is_code(G, n) -> bool:
    return G.nodes[n].get("file_type", "") == "code"


def is_template(G, n) -> bool:
    if is_code(G, n):
        return False
    l = norm(G.nodes[n].get("label", n))
    return l in TEMPLATE_LABELS or any(s in l for s in STRUCTURAL_SUBSTR)


def drop_templates(G):
    drop = [n for n in G.nodes if is_template(G, n)]
    counts = Counter(str(G.nodes[n].get("label", n))[:40] for n in drop)
    G.remove_nodes_from(drop)
    return len(drop), counts


def merge_duplicate_concepts(G):
    """Collapse non-code nodes that share a normalized label into one canonical
    (highest-degree) node, rewiring edges. Returns count of merged-away nodes."""
    groups = defaultdict(list)
    for n in G.nodes:
        if not is_code(G, n):
            groups[norm(G.nodes[n].get("label", n))].append(n)

    mapping = {}
    for members in groups.values():
        if len(members) > 1:
            canon = max(members, key=lambda n: G.degree(n))
            for m in members:
                if m != canon:
                    mapping[m] = canon

    for src, canon in mapping.items():
        if src not in G:
            continue
        for nb in list(G.neighbors(src)):
            tgt = mapping.get(nb, nb)
            if tgt == canon or nb == canon:
                continue
            d = G.get_edge_data(src, nb) or {}
            G.add_edge(canon, tgt, **{k: v for k, v in d.items() if k not in ("source", "target")})
        G.remove_node(src)

    import networkx as nx

    G.remove_edges_from(list(nx.selfloop_edges(G)))
    return len(mapping)


def components_stats(G):
    import networkx as nx

    comps = list(nx.connected_components(G.to_undirected()))
    return len(comps), (max((len(c) for c in comps), default=0))


def review_candidates(G):
    """Non-code labels appearing >= REVIEW_FREQ times that are NOT blocklisted."""
    cnt = Counter(norm(G.nodes[n].get("label", n)) for n in G.nodes if not is_code(G, n))
    out = []
    for lbl, c in cnt.most_common():
        if c >= REVIEW_FREQ and lbl not in TEMPLATE_LABELS and not any(s in lbl for s in STRUCTURAL_SUBSTR):
            out.append((lbl, c))
    return out


def short(s: str, n: int = 30) -> str:
    s = str(s)
    return (s[: n - 1] + "…") if len(s) > n else s


def main() -> int:
    ap = argparse.ArgumentParser(description="Clean the Мнемозина knowledge graph (durable post-graphify pass).")
    ap.add_argument("graph", nargs="?", default=DEFAULT_GRAPH, help="path to graph.json")
    ap.add_argument("--review", action="store_true", help="list freq>=%d labels not in blocklist" % REVIEW_FREQ)
    ap.add_argument("--no-viz", action="store_true", help="skip graph.html regeneration")
    args = ap.parse_args()

    graph_path = Path(args.graph)
    if not graph_path.exists():
        print(f"error: {graph_path} not found", file=sys.stderr)
        return 1
    out_dir = graph_path.parent

    try:
        from graphify.cluster import cluster, score_all
        from graphify.export import to_json
    except ImportError:
        print("error: graphify not importable in this interpreter", file=sys.stderr)
        return 1

    G = load_graph(graph_path)
    n0, e0 = G.number_of_nodes(), G.number_of_edges()
    comps0, big0 = components_stats(G)

    # 1) backup
    (out_dir / ".graph_preclean.json").write_text(graph_path.read_text())

    # 2) drop templates
    dropped, drop_counts = drop_templates(G)
    # 3) merge duplicate concepts
    merged = merge_duplicate_concepts(G)

    n1, e1 = G.number_of_nodes(), G.number_of_edges()
    comps1, big1 = components_stats(G)

    # 4) recluster + auto-label
    communities = cluster(G)
    cohesion = score_all(G, communities)
    labels = {}
    for c, members in communities.items():
        top = max(members, key=lambda n: G.degree(n))
        labels[c] = short(G.nodes[top].get("label", top))
        for n in members:
            G.nodes[n]["community"] = c

    # 5) save graph + labels
    to_json(G, communities, str(graph_path), force=True)
    (out_dir / ".graphify_labels.json").write_text(
        json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False)
    )

    # 5b) regenerate report + html
    try:
        from graphify.analyze import god_nodes, surprising_connections
        from graphify.detect import detect
        from graphify.report import generate

        root = (out_dir / ".graphify_root")
        scan_root = Path(root.read_text().strip()) if root.exists() else out_dir.parent
        det = detect(scan_root)
        rep = generate(
            G, communities, cohesion, labels,
            god_nodes(G), surprising_connections(G, communities),
            det, {"input": 0, "output": 0}, str(scan_root),
        )
        (out_dir / "GRAPH_REPORT.md").write_text(rep)
    except Exception as exc:  # report is non-critical
        print(f"warn: report not regenerated ({exc})", file=sys.stderr)

    if not args.no_viz:
        import subprocess

        try:
            subprocess.run(["graphify", "export", "html"], cwd=str(out_dir.parent), check=False,
                           capture_output=True, timeout=120)
        except Exception as exc:
            print(f"warn: html not regenerated ({exc})", file=sys.stderr)

    # 6) ledger
    print("graphify_clean — ledger")
    print("─" * 46)
    print(f"  nodes:       {n0} → {n1}   (dropped {dropped} templates, merged {merged} dups)")
    print(f"  edges:       {e0} → {e1}")
    print(f"  components:  {comps0} → {comps1}")
    print(f"  largest:     {big0} ({big0*100//max(n0,1)}%) → {big1} ({big1*100//max(n1,1)}%)")
    print(f"  communities: {len(communities)}")
    if dropped:
        top = drop_counts.most_common(8)
        print("  top dropped: " + ", ".join(f"{k}×{v}" for k, v in top))

    cands = review_candidates(G)
    if cands:
        print(f"\n  ⚠ {len(cands)} non-blocklisted label(s) appear ≥{REVIEW_FREQ}× — review if template noise:")
        for lbl, c in cands[:12]:
            print(f"      {c:3}  {short(lbl, 48)}")
        print("  (add real template fields to TEMPLATE_LABELS; leave genuine concepts)")

    if args.review and not cands:
        print(f"\n  no non-blocklisted labels at freq ≥{REVIEW_FREQ} — blocklist is current.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
