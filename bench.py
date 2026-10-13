"""Mede o encaixe de um projeto gravado, para comparar versões do motor.

    python bench.py                      # todos os projetos em data/
    python bench.py data/project_x.json --seconds 60 --cs 1

Só lê os arquivos. Para cada grupo (material · espessura) mostra chapas usadas,
comprimento usado na última chapa e o aproveitamento efetivo: área das peças
dividida pela área realmente consumida (chapas cheias + trecho usado da última).
"""

from __future__ import annotations

import argparse
import glob
import json
import multiprocessing
import os
import time
from concurrent.futures import ProcessPoolExecutor

import engine
import store


def groups_of(doc: dict) -> dict:
    out = {}
    sizes = doc.get("groups") or {}
    for p in doc.get("parts") or []:
        if not p.get("on"):
            continue
        key = "%s · %s mm" % (p["mat"], p["th"])
        size = sizes.get(key) or {"w": 3000, "h": 1500}
        g = out.setdefault(key, {"w": size["w"], "h": size["h"], "items": []})
        for _ in range(int(p["qty"])):
            g["items"].append({
                "id": p["id"], "rings": p["rings"], "area": p["A"],
                "mirror": bool(p.get("mirror")), "rot": p.get("rot", "auto"), "gid": p.get("groupId") or "",
            })
    return out


def measure(path: str, args, pool) -> list:
    doc = json.load(open(path, encoding="utf-8"))
    groups = groups_of(doc)
    if not groups:
        return []
    payload = {"gap": args.gap, "mar": args.mar, "rot": args.rot, "cs": args.cs, "seconds": args.seconds, "groups": groups}
    t0 = time.time()
    res = engine.nest_all(payload, pool, args.workers, args.motor)
    took = time.time() - t0
    rows = []
    for key, g in groups.items():
        r = res[key]
        n = len(r["sheets"])
        placed = {}
        for sh in r["sheets"]:
            for q in sh:
                placed[q["id"]] = placed.get(q["id"], 0) + 1
        area_of = {i["id"]: i["area"] for i in g["items"]}
        area = sum(area_of[i] * c for i, c in placed.items())
        last = r["extent"][-1] if r["extent"] else 0
        consumed = (max(0, n - 1) * g["w"] + last) * g["h"]
        rows.append({
            "grupo": key, "pecas": len(g["items"]), "fora": len(r["fail"]), "chapas": n, "ultima_mm": last,
            "bruto": area / (n * g["w"] * g["h"]) * 100 if n else 0.0,
            "efetivo": area / consumed * 100 if consumed else 0.0,
            "iters": r.get("iters", 0), "segundos": took, "motor": r.get("engine", "?"),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--cs", type=float, default=2, help="resolução da grade em mm")
    ap.add_argument("--gap", type=float, default=4)
    ap.add_argument("--mar", type=float, default=5)
    ap.add_argument("--rot", type=int, default=-1, help="-1 = livre 360°")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--motor", choices=("auto", "rust", "python"), default="auto")
    args = ap.parse_args()
    files = args.files or sorted(glob.glob(str(store.data_dir() / "project_*.json")))
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for path in files:
            rows = measure(path, args, pool)
            if not rows:
                continue
            print("%s  (motor %s, pedido %.0f s, levou %.0f s, grade %g mm, espaço %g, margem %g, %d núcleos)" % (
                os.path.basename(path), rows[0]["motor"], args.seconds, rows[0]["segundos"], args.cs, args.gap, args.mar, args.workers))
            for r in rows:
                print("  %-22s %3d peças  %d chapa(s)  última %4d mm  efetivo %5.1f%%  bruto %5.1f%%  fora %d  %d tentativas" % (
                    r["grupo"], r["pecas"], r["chapas"], r["ultima_mm"], r["efetivo"], r["bruto"], r["fora"], r["iters"]))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
