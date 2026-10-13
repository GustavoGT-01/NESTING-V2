"""Motor de encaixe do servidor.

Regras opcionais em payload["rules"] decidem quais conjuntos podem dividir uma chapa.
A máscara e a busca local continuam as mesmas.

Cada orientação da peça vira uma máscara de bits (um inteiro por linha da grade).
A chapa também é uma lista de inteiros. Achar a posição mais à esquerda de uma peça
em cada linha vira operação de bits em inteiros grandes, o que é bem mais rápido que
testar célula a célula. Sobre isso roda uma busca local com limite de tempo: troca a
ordem das peças e fica com a melhor solução (menos chapas, depois menor comprimento
usado na última chapa).
"""

from __future__ import annotations

import math
import random
import time


def transform(rings, ang, mir):
    a = math.radians(ang)
    c, s = math.cos(a), math.sin(a)
    out = []
    for r in rings:
        pts = []
        for x, y in r:
            if mir:
                x = -x
            pts.append((x * c - y * s, x * s + y * c))
        out.append(pts)
    x0 = min(p[0] for r in out for p in r)
    y0 = min(p[1] for r in out for p in r)
    x1 = max(p[0] for r in out for p in r)
    y1 = max(p[1] for r in out for p in r)
    out = [[(x - x0, y - y0) for x, y in r] for r in out]
    return out, x1 - x0, y1 - y0


def _hull(pts):
    pts = sorted({(float(p[0]), float(p[1])) for p in pts})
    if len(pts) < 3:
        return pts

    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
                h.pop()
            h.append(p)
        return h

    lo, up = half(pts), half(reversed(pts))
    return lo[:-1] + up[:-1]


def hull_angles(rings, n_long=3, n_area=3):
    """Ângulos que deitam um lado do casco convexo sobre o eixo X: bons para peças
    curvas (corda do arco encostada na borda) e para achar o retângulo mínimo."""
    h = _hull([p for p in rings[0]])
    if len(h) < 3:
        return []
    edges = []
    for i in range(len(h)):
        a, b = h[i], h[(i + 1) % len(h)]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L > 1e-6:
            edges.append((L, (-math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))) % 360))
    edges.sort(reverse=True)
    out = [e[1] for e in edges[:n_long]]
    scored = []
    for _, ang in edges[: max(n_long, 24)]:
        c, s_ = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        xs = [p[0] * c - p[1] * s_ for p in h]
        ys = [p[0] * s_ + p[1] * c for p in h]
        scored.append(((max(xs) - min(xs)) * (max(ys) - min(ys)), ang))
    scored.sort()
    out += [a for _, a in scored[:n_area]]
    out += [(a + 180) % 360 for a in list(out)]
    return out


def angle_set(rings, rot, mode):
    """rot: passo global em graus (-1 = livre 360°, 0 = sem giro). mode: auto|free|90|180|0."""
    if mode == "0":
        return [0.0]
    if mode == "180":
        return [0.0, 180.0]
    if mode == "90":
        return [0.0, 90.0, 180.0, 270.0]
    free = mode == "free" or rot == -1
    step = 15 if free else rot
    if step <= 0:
        return [0.0]
    angs = set(float(a) for a in range(0, 360, step))
    if free:
        angs |= {round(a, 2) for a in hull_angles(rings)}
    return sorted(angs)


def refine(a, spread=(-4, -2, 0, 2, 4)):
    return [round((a + d) % 360, 2) for d in spread]


def cover(o, length):
    """Bit x ligado se algum bit de o em [x, x+length) estiver ligado."""
    d, w = o, 1
    while w < length:
        st = min(w, length - w)
        d |= d >> st
        w += st
    return d


def runs_of(v):
    out = []
    while v:
        low = v & -v
        s = low.bit_length() - 1
        t = v + low
        e = (t & -t).bit_length() - 1
        out.append((s, e - s))
        v &= t
    return out


class Mask:
    __slots__ = ("W", "H", "rows")

    def __init__(self, rings, w, h, cs, r):
        W = math.ceil(w / cs) + 1 + 2 * r
        H = math.ceil(h / cs) + 1 + 2 * r
        rows = [0] * H
        for y in range(H):
            yy = (y - r + 0.5) * cs
            xs = []
            for q in rings:
                n = len(q)
                for i in range(n):
                    a, b = q[i], q[(i + 1) % n]
                    if (a[1] > yy) != (b[1] > yy):
                        xs.append(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]))
            xs.sort()
            v = 0
            for k in range(0, len(xs) - 1, 2):
                x0 = max(0, round(xs[k] / cs - 0.5) + r)
                x1 = min(W - 1, round(xs[k + 1] / cs - 0.5) + r)
                if x1 >= x0:
                    v |= ((1 << (x1 - x0 + 1)) - 1) << x0
            rows[y] = v
        if r > 0:
            rows = [(cover(v, 2 * r + 1) << r) & ((1 << W) - 1) for v in rows]
            rows = [
                _or(rows[max(0, y - r): y + r + 1]) for y in range(H)
            ]
        self.W, self.H = W, H
        self.rows = [(y, runs_of(v)) for y, v in enumerate(rows) if v]


def _or(seq):
    v = 0
    for x in seq:
        v |= x
    return v


class Sheet:
    __slots__ = ("W", "H", "occ", "cov", "placed", "extent", "gids")

    def __init__(self, W, H):
        self.W, self.H = W, H
        self.occ = [0] * H
        self.cov = [dict() for _ in range(H)]
        self.placed = []
        self.extent = 0
        self.gids = set()

    def cover(self, row, length):
        c = self.cov[row]
        v = c.get(length)
        if v is None:
            v = c[length] = cover(self.occ[row], length)
        return v

    def find(self, m, cap):
        """Melhor (gx, gy) leftmost; cap limita gx para podar."""
        best = None
        maxx = min(self.W - m.W, cap - 1)
        if maxx < 0 or self.H < m.H:
            return None
        for gy in range(0, self.H - m.H + 1):
            valid = (1 << (best[0] if best else maxx + 1)) - 1
            if not valid:
                break
            forb = 0
            for ry, runs in m.rows:
                if self.occ[gy + ry]:
                    for s, l in runs:
                        forb |= self.cover(gy + ry, l) >> s
                    if not (valid & ~forb):
                        break
            free = valid & ~forb
            if free:
                gx = (free & -free).bit_length() - 1
                if best is None or gx < best[0]:
                    best = (gx, gy)
                    if gx == 0:
                        break
        return best

    def put(self, m, gx, gy):
        for ry, runs in m.rows:
            v = 0
            for s, l in runs:
                v |= ((1 << l) - 1) << s
            self.occ[gy + ry] |= v << gx
            self.cov[gy + ry].clear()
        self.extent = max(self.extent, gx + m.W)


def _allows(have, gid, rules):
    """True se a peça deste conjunto pode entrar nesta chapa.

    mix: conjuntos diferentes compartilham chapa.
    isolate: conjunto só com ele mesmo, em quantas chapas precisar.
    together: conjunto só com ele mesmo e numa chapa só (quem chama limita a segunda).
    forbid: pares que não podem coexistir.
    """
    isolate = set(rules.get("isolate") or ())
    together = set(rules.get("together") or ())
    forbid = rules.get("forbid") or ()
    if gid in together:
        return (not have) or have == {gid}
    if have & together:
        return False
    if gid in isolate or (have & isolate):
        return (not have) or have == {gid}
    if not rules.get("mix", True):
        return (not have) or have == {gid}
    for pair in forbid:
        a, b = pair[0], pair[1]
        if (gid == a and b in have) or (gid == b and a in have):
            return False
    return True


def pack(order, g, opt, cache):
    cs, r = opt["cs"], opt["r"]
    W = int((g["w"] - 2 * opt["mar"]) // cs)
    H = int((g["h"] - 2 * opt["mar"]) // cs)
    rules = opt.get("rules") or {"mix": True, "isolate": [], "together": [], "forbid": []}
    together = set(rules.get("together") or ())
    sheets, fail, why = [], [], []
    if W < 1 or H < 1:
        return sheets, [it["uid"] for it in order], ["tamanho"] * len(order)
    opened = {}
    for it in order:
        gid = str(it.get("gid") or "")
        angs, gene = it["angs"], it.get("gene", 0)
        placed = False
        for si in range(len(sheets) + 1):
            if si == len(sheets):
                if gid in together and gid in opened:
                    fail.append(it["uid"])
                    why.append("junto")
                    placed = True
                    break
                sheets.append(Sheet(W, H))
            sh = sheets[si]
            if gid in together and gid in opened and si != opened[gid]:
                continue
            if not _allows(sh.gids, gid, rules):
                if si == len(sheets) - 1 and not sh.placed:
                    sheets.pop()
                    fail.append(it["uid"])
                    why.append("tamanho")
                    placed = True
                    break
                continue
            cands = []
            for a in angs:
                for mi in (0, 1) if it["mirror"] else (0,):
                    k = (it["id"], a, mi)
                    c = cache.get(k)
                    if c is None:
                        rings, w, h = transform(it["rings"], a, mi)
                        c = cache[k] = (Mask(rings, w, h, cs, r), w, h)
                    m = c[0]
                    if m.W > W or m.H > H:
                        continue
                    cap = (cands[gene][0][0] - m.W + 1) if len(cands) > gene else W
                    sp = sh.find(m, cap)
                    if sp is None:
                        continue
                    cands.append(((sp[0] + m.W, sp[1]), a, mi, m, sp))
                    cands.sort(key=lambda c_: c_[0])
            if cands:
                _, a, mi, m, sp = cands[min(gene, len(cands) - 1)]
                sh.put(m, *sp)
                sh.gids.add(gid)
                if gid in together and gid not in opened:
                    opened[gid] = si
                sh.placed.append(
                    (it["uid"], it["id"], a, mi, opt["mar"] + (sp[0] + r) * cs, opt["mar"] + (sp[1] + r) * cs)
                )
                placed = True
                break
            if si == len(sheets) - 1 and not sh.placed:
                sheets.pop()
                fail.append(it["uid"])
                why.append("tamanho")
                placed = True
                break
        if not placed:
            fail.append(it["uid"])
            why.append("tamanho")
    return sheets, fail, why


def score(res):
    sheets, fail = res[0], res[1]
    last = sheets[-1].extent if sheets else 0
    return (len(fail), len(sheets), last)


def _search(items, g, opt, seconds, rnd, seeds=None):
    """Busca local sobre ordem + gene de diversificação. Devolve (ordem, resultado, score)."""
    cache = {}
    deadline = time.time() + seconds
    box = lambda i: (max(p[0] for r in i["rings"] for p in r), max(p[1] for r in i["rings"] for p in r))
    starts = seeds or [
        sorted(items, key=lambda i: -i["area"]),
        sorted(items, key=lambda i: -max(box(i))),
        sorted(items, key=lambda i: -(box(i)[0] * box(i)[1])),
    ]
    best = None
    for o in starts:
        res = pack(o, g, opt, cache)
        sc = score(res)
        if best is None or sc < best[2]:
            best = (o, res, sc)
        if time.time() > deadline:
            break
    iters = 0
    while time.time() < deadline and len(best[0]) > 1:
        o = [dict(x) for x in best[0]]
        for _ in range(rnd.choice((1, 1, 2, 3))):
            i, j = rnd.randrange(len(o)), rnd.randrange(len(o))
            t = rnd.random()
            if t < 0.4:
                o[i], o[j] = o[j], o[i]
            elif t < 0.8:
                o.insert(j, o.pop(i))
            else:
                o[i]["gene"] = 1 - o[i].get("gene", 0)
        res = pack(o, g, opt, cache)
        sc = score(res)
        iters += 1
        if sc <= best[2]:
            best = (o, res, sc)
    return best[0], best[1], best[2], iters


def nest_group(g, items, opt, seconds, seed=1):
    """g={w,h}; items=[{id,rings,mirror,area,rot?}] já expandidos por quantidade.

    Etapa 1 (grossa, ~55% do tempo): grade de 4 mm, muitos ângulos, acha ordem e giro.
    Etapa 2 (fina): grade pedida, ângulos refinados ao redor dos escolhidos."""
    rnd = random.Random(seed)
    rot = opt["rot"]
    gap, mar, cs = opt["gap"], opt["mar"], opt["cs"]
    cache_angs = {}
    items = [dict(i, uid=n, gene=0) for n, i in enumerate(items)]
    for it in items:
        it["gid"] = str(it.get("gid") or "")
        k = (it["id"], it.get("rot", "auto"))
        if k not in cache_angs:
            cache_angs[k] = angle_set(it["rings"], rot, str(it.get("rot", "auto")))
        it["angs"] = cache_angs[k]
    free_any = any(len(i["angs"]) > 4 for i in items)
    t1 = seconds * (0.55 if free_any else 0.4)
    cs1 = max(cs, 4.0) if free_any else cs
    rules = opt.get("rules") or {"mix": True, "isolate": [], "together": [], "forbid": []}
    o1 = {"cs": cs1, "gap": gap, "mar": mar, "r": math.ceil(gap / 2 / cs1), "rules": rules}
    order, res, sc, it1 = _search(items, g, o1, t1, rnd)
    # etapa 2: refina ângulos ao redor do escolhido por peça
    chosen = {}
    for sh in res[0]:
        for uid, pid, a, mi, x, y in sh.placed:
            chosen[uid] = (a, mi)
    fine = []
    for it in order:
        n = dict(it)
        a = chosen.get(it["uid"], (None, 0))[0]
        if a is not None and free_any and len(it["angs"]) > 4:
            n["angs"] = sorted(set(refine(a)) | ({0.0, 180.0} if 0.0 in it["angs"] else set()))
        fine.append(n)
    o2 = {"cs": cs, "gap": gap, "mar": mar, "r": math.ceil(gap / 2 / cs), "rules": rules}
    cache2 = {}
    r1 = pack(fine, g, o2, cache2)
    best = (fine, r1, score(r1))
    plain = sorted(items, key=lambda i: -i["area"])
    r2 = pack(plain, g, o2, cache2)
    if score(r2) < best[2]:
        best = (plain, r2, score(r2))
    left = max(0.5, seconds - t1 - 0.0)
    order2, res2, sc2, it2 = _search(items, g, o2, left * 0.9, rnd, seeds=[best[0]])
    if sc2 < best[2]:
        best = (order2, res2, sc2)
    packed = best[1]
    sheets, fail = packed[0], packed[1]
    why = packed[2] if len(packed) > 2 else ["tamanho"] * len(fail)
    return {
        "sheets": [
            [{"id": pid, "a": a, "mi": mi, "x": x, "y": y} for uid, pid, a, mi, x, y in sh.placed]
            for sh in sheets
        ],
        "fail": [items[u]["id"] for u in fail],
        "fail_why": why,
        "iters": it1 + it2,
        "extent": [round(mar + sh.extent * cs) for sh in sheets],
    }


def _worker(args):
    g, items, opt, seconds, seed = args
    return nest_group(g, items, opt, seconds, seed)


def _key(r):
    return (len(r["fail"]), len(r["sheets"]), r["extent"][-1] if r["extent"] else 0)


def _id_list(value):
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for item in value:
        text = str(item).strip() if item is not None else ""
        if text and text not in out:
            out.append(text)
    return out


def _rules(payload):
    """Regras de conjunto. Ausente = mistura livre, igual ao encaixe antigo."""
    raw = payload.get("rules")
    if not isinstance(raw, dict):
        raw = {}
    forbid = []
    pairs = raw.get("forbid")
    if isinstance(pairs, (list, tuple)):
        for pair in pairs:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            a, b = str(pair[0]).strip(), str(pair[1]).strip()
            if a and b and a != b and (a, b) not in forbid and (b, a) not in forbid:
                forbid.append((a, b))
    return {
        "mix": bool(raw.get("mix", True)),
        "isolate": _id_list(raw.get("isolate")),
        "together": _id_list(raw.get("together")),
        "forbid": forbid,
    }


def nest_all(payload, pool=None, workers=1):
    """Com pool, cada grupo roda em `workers` processos ao mesmo tempo (sementes
    diferentes) e fica a melhor solução; usa todos os núcleos do processador."""
    opt = {
        "gap": float(payload.get("gap", 4)),
        "mar": float(payload.get("mar", 5)),
        "rot": int(payload.get("rot", 90)),
        "cs": float(payload.get("cs", 2)),
        "rules": _rules(payload),
    }
    total = float(payload.get("seconds", 20))
    want = int(payload.get("workers", 0)) or workers
    workers = max(1, min(workers, want))
    groups = payload["groups"]
    weight = {k: max(1.0, sum(i["area"] for i in v["items"])) for k, v in groups.items()}
    wsum = sum(weight.values())
    out = {}
    for k, v in groups.items():
        g = {"w": v["w"], "h": v["h"]}
        secs = max(1.0, total * weight[k] / wsum)
        if pool is None or workers < 2:
            out[k] = nest_group(g, v["items"], opt, secs)
            out[k]["workers"] = 1
            continue
        futs = [pool.submit(_worker, (g, v["items"], opt, secs, 1 + 97 * n)) for n in range(workers)]
        res = [f.result() for f in futs]
        best = min(res, key=_key)
        best["iters"] = sum(r["iters"] for r in res)
        best["workers"] = workers
        out[k] = best
    return out
