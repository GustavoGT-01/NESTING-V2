"""Motor de encaixe do servidor.

Regras opcionais em payload["rules"] decidem quais conjuntos podem dividir uma chapa.
A máscara e a busca local continuam as mesmas.

Cada orientação da peça vira uma máscara de bits (um inteiro por linha da grade).
A chapa também é uma lista de inteiros. Achar a posição mais à esquerda de uma peça
em cada linha vira operação de bits em inteiros grandes, o que é bem mais rápido que
testar célula a célula. Sobre isso roda uma busca local com limite de tempo: troca a
ordem das peças e fica com a melhor solução (menos chapas, depois menor comprimento
usado na última chapa).

Dois critérios de posição rodam em paralelo (metade dos núcleos cada) e vence o melhor:
"x" avança o mínimo no comprimento da chapa; "box" ocupa o menor retângulo, o que deita
e empilha peças longas e finas. Cada chapa lembra a última posição achada para cada
orientação de peça: como a chapa só enche, a busca seguinte parte dali.
"""

from __future__ import annotations

import math
import os
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
    __slots__ = ("W", "H", "rows", "cells", "scan")

    def __init__(self, rings, w, h, cs, r):
        W = math.ceil(w / cs) + 1 + 2 * r
        H = math.ceil(h / cs) + 1 + 2 * r
        rows = [0] * H
        cross = [[] for _ in range(H)]
        for q in rings:
            n = len(q)
            for i in range(n):
                a, b = q[i], q[(i + 1) % n]
                lo, hi = (a[1], b[1]) if a[1] < b[1] else (b[1], a[1])
                if lo == hi:
                    continue
                # linhas com lo <= yy < hi, onde yy = (y - r + 0.5) * cs
                y = max(0, math.ceil(lo / cs + r - 0.5) - 1)
                y1 = min(H - 1, math.floor(hi / cs + r - 0.5) + 1)
                while y <= y1:
                    yy = (y - r + 0.5) * cs
                    if (a[1] > yy) != (b[1] > yy):
                        cross[y].append(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]))
                    y += 1
        # Além do miolo (linha no centro de cada faixa), marca toda célula que o contorno
        # toca: assim a máscara sempre cobre a peça inteira, inclusive pontas agudas que
        # passariam entre duas linhas, e a folga pedida vira um mínimo de verdade.
        edge = [0] * H
        for q in rings:
            n = len(q)
            for i in range(n):
                a, b = q[i], q[(i + 1) % n]
                lo, hi = (a[1], b[1]) if a[1] < b[1] else (b[1], a[1])
                y = max(0, math.floor(lo / cs) + r)
                y1 = min(H - 1, math.floor(hi / cs) + r)
                while y <= y1:
                    if lo == hi:
                        xa, xb = a[0], b[0]
                    else:
                        b0 = (y - r) * cs
                        ya, yb = max(lo, b0), min(hi, b0 + cs)
                        xa = a[0] + (ya - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
                        xb = a[0] + (yb - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
                    x0 = max(0, math.floor(min(xa, xb) / cs) + r)
                    x1 = min(W - 1, math.floor(max(xa, xb) / cs) + r)
                    if x1 >= x0:
                        edge[y] |= ((1 << (x1 - x0 + 1)) - 1) << x0
                    y += 1
        for y in range(H):
            xs = cross[y]
            xs.sort()
            v = edge[y]
            for k in range(0, len(xs) - 1, 2):
                x0 = max(0, round(xs[k] / cs - 0.5) + r)
                x1 = min(W - 1, round(xs[k + 1] / cs - 0.5) + r)
                if x1 >= x0:
                    v |= ((1 << (x1 - x0 + 1)) - 1) << x0
            rows[y] = v
        if r > 0:
            # engrossa r células para a esquerda e para a direita (antes o lado esquerdo
            # da peça ficava sem folga, e a distância real saía menor que a pedida)
            rows = [cover(v << r, 2 * r + 1) & ((1 << W) - 1) for v in rows]
            rows = [
                _or(rows[max(0, y - r): y + r + 1]) for y in range(H)
            ]
        self.W, self.H = W, H
        self.rows = [(y, runs_of(v)) for y, v in enumerate(rows) if v]
        self.cells = sum(l for _, runs in self.rows for _, l in runs)
        # Ordem de teste de colisão: linhas espalhadas primeiro (meio, quartos, ...),
        # para achar o choque cedo em vez de varrer linhas vizinhas quase iguais.
        n = len(self.rows)
        bits = max(1, (n - 1).bit_length())
        self.scan = [self.rows[i] for i in sorted(range(n), key=lambda i: int(format(i, "0%db" % bits)[::-1], 2))]


def _or(seq):
    v = 0
    for x in seq:
        v |= x
    return v


class Sheet:
    __slots__ = ("W", "H", "occ", "cov", "placed", "extent", "gids", "used", "memo", "top")

    def __init__(self, W, H):
        self.W, self.H = W, H
        self.occ = [0] * H
        self.cov = [dict() for _ in range(H)]
        self.placed = []
        self.extent = 0
        self.gids = set()
        self.used = 0
        self.top = 0
        # Por orientação de peça: última posição achada, ou False se já não cabe.
        # A chapa só enche, então a melhor posição (gx, depois gy) nunca recua.
        self.memo = {}

    def cover(self, row, length):
        c = self.cov[row]
        v = c.get(length)
        if v is None:
            v = c[length] = cover(self.occ[row], length)
        return v

    def fits(self, m, gx, gy):
        occ = self.occ
        for ry, runs in m.scan:
            o = occ[gy + ry]
            if o:
                o >>= gx
                for s, l in runs:
                    if (o >> s) & ((1 << l) - 1):
                        return False
        return True

    def find(self, m, cap, last=None, e=0):
        """Melhor (gx, gy) leftmost; cap limita gx para podar.

        last = posição devolvida antes para a mesma máscara nesta chapa: nada à
        esquerda dela (nem abaixo, na mesma coluna) volta a ficar livre."""
        best = None
        maxx = min(self.W - m.W - e, cap - 1)
        if maxx < e or self.H < m.H + 2 * e:
            return None
        ymax = self.H - m.H - e
        lo = e
        if last:
            gx0, gy0 = last
            if gx0 > maxx:
                return None
            for gy in range(max(gy0, e), ymax + 1):
                if self.fits(m, gx0, gy):
                    return (gx0, gy)
            lo = gx0 + 1
            if lo > maxx:
                return None
        below = (1 << lo) - 1
        for gy in range(e, ymax + 1):
            valid = ((1 << (best[0] if best else maxx + 1)) - 1) & ~below
            if not valid:
                break
            forb = 0
            for ry, runs in m.scan:
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
                    if gx == lo:
                        break
        return best

    def put(self, m, gx, gy, big=None, d=0):
        """Ocupa a chapa com a peça. `big` é a mesma peça com folga maior (d células a
        mais de cada lado): o que passar da borda da chapa é cortado."""
        full = (1 << self.W) - 1
        x = gx - d
        for ry, runs in (big or m).rows:
            y = gy - d + ry
            if y < 0 or y >= self.H:
                continue
            v = 0
            for s, l in runs:
                v |= ((1 << l) - 1) << s
            self.occ[y] |= (v << x if x >= 0 else v >> -x) & full
            self.cov[y].clear()
        self.extent = max(self.extent, gx + m.W)
        self.used += m.cells
        self.top = max(self.top, gy + m.H)


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


def _mm(v, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return float(default)
    return v if math.isfinite(v) and v >= 0 else float(default)


def item_cells(it, opt):
    """Folga por peça. O encaixe roda com o menor espaço (r0, rb0); a peça com espaço maior
    ganha células nas duas máscaras, e duas peças ficam sempre a pelo menos o maior dos
    dois espaços: rb_a + r_b >= max(T_a, T_b). A margem própria vira recuo e da borda."""
    cs = opt["cs"]
    t = max(0, math.ceil(_mm(it.get("gap"), opt.get("gap", 0)) / cs - 1e-9))
    r0, rb0 = opt["r"], opt.get("rb", opt["r"])
    e = max(0, math.ceil((_mm(it.get("mar"), opt["mar"]) - opt["mar"]) / cs - 1e-9))
    return max(r0, t - rb0), max(rb0, t - r0), e


def radii(gap, cs):
    """Folga em células para garantir `gap` mm reais entre duas peças.

    A máscara cobre a peça inteira, então duas peças com T células livres entre elas
    ficam a pelo menos T * cs mm. T é repartido entre a máscara que testa a posição (r)
    e a que ocupa a chapa (rb); com T ímpar, rb = r + 1."""
    total = max(0, math.ceil(gap / cs - 1e-9))
    return {"r": total // 2, "rb": total - total // 2}


def _due(halt):
    """Prazo global ou arquivo de parada. Não olha o orçamento de uma etapa."""
    if not halt:
        return False
    t = halt.get("t")
    if t is not None and time.time() >= t:
        return True
    path = halt.get("stop")
    return bool(path and os.path.exists(path))


def _cut(halt):
    if _due(halt):
        halt["cut"] = True
        return True
    return False


def pack(order, g, opt, cache, halt=None):
    cs = opt["cs"]
    W = int((g["w"] - 2 * opt["mar"]) // cs)
    H = int((g["h"] - 2 * opt["mar"]) // cs)
    rules = opt.get("rules") or {"mix": True, "isolate": [], "together": [], "forbid": []}
    together = set(rules.get("together") or ())
    sheets, fail, why = [], [], []
    if W < 1 or H < 1:
        return sheets, [it["uid"] for it in order], ["tamanho"] * len(order)
    opened = {}
    # "x": menor avanço no comprimento (clássico). "box": menor retângulo ocupado,
    # que deita peças longas e finas e as empilha em vez de incliná-las.
    box = opt.get("crit") == "box"
    # planejamento: produtos na ordem da lista (a busca só reordena dentro de cada produto)
    if opt.get("seq"):
        order = sorted(order, key=lambda o: o.get("rank", 0))
    near = bool(opt.get("near"))
    span = {}
    for idx, it in enumerate(order):
        if _cut(halt):
            # tentativa cortada no meio: o que já está na chapa fica; o resto não entra
            for rest in order[idx:]:
                fail.append(rest["uid"])
                why.append("prazo")
            if sheets and not sheets[-1].placed:
                sheets.pop()
            return sheets, fail, why
        gid = str(it.get("gid") or "")
        angs, gene = it["angs"], it.get("gene", 0)
        r, rb, edge = item_cells(it, opt)
        placed = False
        n0 = len(sheets)
        prod = it.get("prod") or ""
        if near and prod and prod in span:
            # produto junto: chapas onde ele já está, depois as vizinhas; o resto só se não couber
            lo, hi = span[prod]
            tries = [k for k in list(range(lo, hi + 2)) + ([lo - 1] if lo > 0 else []) if k <= n0]
            tries += [k for k in range(n0 + 1) if k not in tries]
        else:
            tries = range(n0 + 1)
        for si in tries:
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
                        c = cache[k] = (Mask(rings, w, h, cs, r), w, h, Mask(rings, w, h, cs, rb) if rb != r else None)
                    m = c[0]
                    if m.W + 2 * edge > W or m.H + 2 * edge > H:
                        continue
                    last = sh.memo.get(k)
                    if last is False:
                        continue
                    if sh.used + m.cells > W * H:
                        sh.memo[k] = False
                        continue
                    cap = W if box else ((cands[gene][0][0] - m.W + 1) if len(cands) > gene else W)
                    sp = sh.find(m, cap, last, edge)
                    if sp is None:
                        if cap >= W:
                            sh.memo[k] = False  # busca completa: não cabe mais nesta chapa
                        continue
                    sh.memo[k] = sp
                    right = sp[0] + m.W
                    if box:
                        key = (max(sh.extent, right) * max(sh.top, sp[1] + m.H), right, sp[1])
                    else:
                        key = (right, sp[1])
                    cands.append((key, a, mi, m, sp))
                    cands.sort(key=lambda c_: c_[0])
            if cands:
                _, a, mi, m, sp = cands[min(gene, len(cands) - 1)]
                sh.put(m, sp[0], sp[1], cache[(it["id"], a, mi)][3], rb - r)
                sh.gids.add(gid)
                if gid in together and gid not in opened:
                    opened[gid] = si
                if prod:
                    lo, hi = span.get(prod, (si, si))
                    span[prod] = (min(lo, si), max(hi, si))
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


def _search(items, g, opt, seconds, rnd, seeds=None, known=None, cache=None, halt=None):
    """Busca local sobre ordem + gene de diversificação. Devolve (ordem, resultado, score)."""
    cache = {} if cache is None else cache
    deadline = time.time() + seconds
    if halt and halt.get("t") is not None:
        deadline = min(deadline, halt["t"])
    box = lambda i: (max(p[0] for r in i["rings"] for p in r), max(p[1] for r in i["rings"] for p in r))
    starts = seeds or [
        sorted(items, key=lambda i: -i["area"]),
        sorted(items, key=lambda i: -max(box(i))),
        sorted(items, key=lambda i: -(box(i)[0] * box(i)[1])),
    ]
    best = known
    for o in ([] if known else starts):
        if time.time() > deadline or _due(halt):
            break
        if halt:
            halt["cut"] = False
        res = pack(o, g, opt, cache, halt)
        if halt and halt.get("cut"):
            if best is None:
                best = (o, res, score(res))  # primeira tentativa não fechou: fica o parcial
            break
        sc = score(res)
        if best is None or sc < best[2]:
            best = (o, res, sc)
        if time.time() > deadline:
            break
    iters = 0
    while best is not None and time.time() < deadline and not _due(halt) and len(best[0]) > 1:
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
        if halt:
            halt["cut"] = False
        res = pack(o, g, opt, cache, halt)
        if halt and halt.get("cut"):
            break  # tentativa incompleta não substitui a última que terminou
        sc = score(res)
        iters += 1
        if sc <= best[2]:
            best = (o, res, sc)
    if best is None:
        blank = ([], [it["uid"] for it in items], ["prazo"] * len(items))
        best = (list(items), blank, score(blank))
    return best[0], best[1], best[2], iters


def nest_group(g, items, opt, seconds, seed=1, crit="x", halt=None):
    """g={w,h}; items=[{id,rings,mirror,area,rot?}] já expandidos por quantidade.

    Etapa 1 (grossa, ~55% do tempo): grade de 4 mm, muitos ângulos, acha ordem e giro.
    Etapa 2 (fina): grade pedida, ângulos refinados ao redor dos escolhidos."""
    rnd = random.Random(seed)
    t0 = time.time()
    rot = opt["rot"]
    cache_angs = {}
    items = [dict(i, uid=n, gene=0) for n, i in enumerate(items)]
    # espaço e margem por peça (sem valor próprio, os do encaixe); a grade usa os menores
    for it in items:
        it["gap"] = _mm(it.get("gap"), opt["gap"])
        it["mar"] = _mm(it.get("mar"), opt["mar"])
    gap = min([opt["gap"]] + [i["gap"] for i in items])
    mar = min([opt["mar"]] + [i["mar"] for i in items])
    cs = opt["cs"]
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
    o1 = {"cs": cs1, "gap": gap, "mar": mar, "rules": rules, "crit": crit, "seq": opt.get("seq"), "near": opt.get("near"), **radii(gap, cs1)}
    if halt is None:
        halt = {"t": time.time() + max(0.0, seconds), "stop": None, "cut": False}
    order, res, sc, it1 = _search(items, g, o1, t1, rnd, halt=halt)
    it2 = 0
    if halt.get("cut"):
        packed = res  # etapa grossa cortada: não começa a grade fina
    else:
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
        o2 = {"cs": cs, "gap": gap, "mar": mar, "rules": rules, "crit": crit, "seq": opt.get("seq"), "near": opt.get("near"), **radii(gap, cs)}
        cache2 = {}
        tp = time.time()
        halt["cut"] = False
        r1 = pack(fine, g, o2, cache2, halt)
        tp = time.time() - tp  # custo de uma tentativa na grade fina
        if halt.get("cut"):
            packed = res  # fina incompleta: fica a etapa grossa, que terminou
        else:
            best = (fine, r1, score(r1))
            # O prazo vale: só gasta outra tentativa na grade fina se ainda couber no tempo pedido.
            if time.time() - t0 + tp < seconds and not _due(halt):
                halt["cut"] = False
                plain = sorted(items, key=lambda i: -i["area"])
                r2 = pack(plain, g, o2, cache2, halt)
                if not halt.get("cut") and score(r2) < best[2]:
                    best = (plain, r2, score(r2))
            left = seconds - (time.time() - t0)
            if left > tp and not halt.get("cut") and not _due(halt):
                order2, res2, sc2, it2 = _search(items, g, o2, left - tp, rnd, known=best, cache=cache2, halt=halt)
                if not halt.get("cut") and sc2 < best[2]:
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
    g, items, opt, seconds, seed, crit, deadline, stop = args
    halt = {"t": deadline, "stop": stop or None, "cut": False}
    return nest_group(g, items, opt, seconds, seed, crit, halt)


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


def _none(items):
    """Grupo que não chegou a rodar: o prazo ou a parada já tinham vencido."""
    return {
        "sheets": [],
        "fail": [it.get("id") for it in items],
        "fail_why": ["prazo"] * len(items),
        "iters": 0,
        "extent": [],
        "workers": 1,
    }


def nest_all(payload, pool=None, workers=1, stop_file=None):
    """Com pool, cada grupo roda em `workers` processos ao mesmo tempo (sementes
    diferentes) e fica a melhor solução; usa todos os núcleos do processador."""
    opt = {
        "gap": float(payload.get("gap", 4)),
        "mar": float(payload.get("mar", 5)),
        "rot": int(payload.get("rot", 90)),
        "cs": float(payload.get("cs", 2)),
        "rules": _rules(payload),
        "seq": bool(payload.get("seq")),
        "near": bool(payload.get("near")),
    }
    total = float(payload.get("seconds", 20))
    want = int(payload.get("workers", 0)) or workers
    workers = max(1, min(workers, want))
    groups = payload["groups"]
    weight = {k: max(1.0, sum(i["area"] for i in v["items"])) for k, v in groups.items()}
    wsum = sum(weight.values()) or 1.0
    deadline = time.time() + total
    halt = {"t": deadline, "stop": stop_file or None, "cut": False}
    out = {}
    for k, v in groups.items():
        g = {"w": v["w"], "h": v["h"]}
        if _due(halt):
            out[k] = _none(v["items"])
            continue
        # sem piso de 1 s: a soma dos grupos cabe no prazo pedido
        share = min(total * weight[k] / wsum, max(0.0, deadline - time.time()))
        if pool is None or workers < 2:
            res = []
            for crit in ("x", "box"):
                if _due(halt):
                    break
                left = deadline - time.time()
                if left <= 0:
                    break
                # cada critério usa metade da cota; "box" nem começa se o prazo acabou
                budget = min(share / 2.0, left)
                if budget <= 0:
                    break
                halt["cut"] = False
                res.append(nest_group(g, v["items"], opt, budget, 1, crit, halt))
                if halt.get("cut"):
                    break
            if not res:
                out[k] = _none(v["items"])
                continue
            out[k] = min(res, key=_key)
            out[k]["iters"] = sum(r["iters"] for r in res)
            out[k]["workers"] = 1
            continue
        # metade dos núcleos com cada critério de posição; fica a melhor solução
        futs = [pool.submit(_worker, (g, v["items"], opt, share, 1 + 97 * n, "box" if n % 2 else "x", deadline, stop_file or "")) for n in range(workers)]
        res = [f.result() for f in futs]
        best = min(res, key=_key)
        best["iters"] = sum(r["iters"] for r in res)
        best["workers"] = workers
        out[k] = best
    return out
