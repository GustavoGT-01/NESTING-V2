"""Usinagem CNC: caminhos de ferramenta e G-code a partir das chapas encaixadas.

Modelo de trabalho no estilo Aspire/Alphacam: biblioteca de ferramentas (diâmetro, rotação,
avanço, mergulho, passo vertical), estratégia (contorno com compensação do raio, rampa,
micro-juntas, furação e rebaixo) e um pós-processador em texto editável (padrão NCStudio).

Coordenadas em mm. Origem X0 Y0 no canto inferior esquerdo da chapa. Z0 no topo da chapa
(ou na mesa, conforme a máquina); Z negativo desce no material.
"""

from __future__ import annotations

import math

EPS = 1e-9
ARC_STEP = math.radians(10)       # cantos arredondados do offset: um ponto a cada 10°
MAX_POINTS = 200_000              # teto de pontos por chapa (proteção de memória)

DEFAULT_POST = {
    "name": "NCStudio (mm)",
    "ext": "nc",
    "header": "G90 G17 G21 G40 G49 G80\nG0 Z{SAFEZ}",
    "toolchange": "T{T} M06\nS{RPM} M03",
    "spindle": "S{RPM} M03",
    "footer": "G0 Z{SAFEZ}\nM05\nG0 X{HOMEX} Y{HOMEY}\nM30",
    "comments": False,
}


class CamError(ValueError):
    pass


# ---------------------------------------------------------------- geometria básica

def area(r) -> float:
    s = 0.0
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        s += x1 * y2 - x2 * y1
    return s / 2


def length(r, closed=True) -> float:
    n = len(r)
    t = sum(math.dist(r[i], r[i + 1]) for i in range(n - 1))
    return t + (math.dist(r[-1], r[0]) if closed and n > 1 else 0)


def clean(r, tol=1e-4):
    """Tira pontos repetidos e colineares (o import achata arcos em muitos pontos)."""
    out = []
    for p in r:
        if not out or math.dist(out[-1], p) > tol:
            out.append((float(p[0]), float(p[1])))
    if len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    changed = True
    while changed and len(out) > 3:
        changed = False
        keep = []
        n = len(out)
        for i in range(n):
            a, b, c = out[i - 1], out[i], out[(i + 1) % n]
            cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
            if abs(cr) <= tol * max(math.dist(a, c), tol) and dot > 0:
                changed = True
                continue
            keep.append(b)
        out = keep if len(keep) >= 3 else out
    return out


def circle_of(r, tol=0.02):
    """(cx, cy, raio) se o anel é um círculo (até 2% de desvio); senão None."""
    if len(r) < 8:
        return None
    cx = sum(p[0] for p in r) / len(r)
    cy = sum(p[1] for p in r) / len(r)
    ds = [math.dist((cx, cy), p) for p in r]
    rad = sum(ds) / len(ds)
    if rad <= 0 or max(abs(d - rad) for d in ds) > tol * rad:
        return None
    return cx, cy, rad


def point_in(pt, r) -> bool:
    x, y = pt
    inside = False
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def seg_dist(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0.0 if L < EPS else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    return math.dist(p, (a[0] + t * dx, a[1] + t * dy))


def ring_dist(p, r) -> float:
    return min(seg_dist(p, r[i - 1], r[i]) for i in range(len(r)))


# ---------------------------------------------------------------- offset (compensação do raio)

def _cross_point(a, b, c, d):
    """Interseção própria dos segmentos ab e cd (ponto) ou None."""
    r = (b[0] - a[0], b[1] - a[1])
    s = (d[0] - c[0], d[1] - c[1])
    den = r[0] * s[1] - r[1] * s[0]
    if abs(den) < EPS:
        return None
    qp = (c[0] - a[0], c[1] - a[1])
    t = (qp[0] * s[1] - qp[1] * s[0]) / den
    u = (qp[0] * r[1] - qp[1] * r[0]) / den
    if 1e-9 < t < 1 - 1e-9 and 1e-9 < u < 1 - 1e-9:
        return (a[0] + t * r[0], a[1] + t * r[1])
    return None


def _first_crossing(pts):
    """Primeiro par de arestas que se cruzam (i < j, não vizinhas), via grade espacial."""
    n = len(pts)
    if n < 4:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1e-6)
    cell = max(span / max(8, int(math.sqrt(n)) * 2), 1e-6)
    grid = {}
    x0, y0 = min(xs), min(ys)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        for gx in range(int((min(a[0], b[0]) - x0) / cell), int((max(a[0], b[0]) - x0) / cell) + 1):
            for gy in range(int((min(a[1], b[1]) - y0) / cell), int((max(a[1], b[1]) - y0) / cell) + 1):
                grid.setdefault((gx, gy), []).append(i)
    best = None
    for bucket in grid.values():
        if len(bucket) < 2:
            continue
        for ii in range(len(bucket)):
            i = bucket[ii]
            for jj in range(ii + 1, len(bucket)):
                j = bucket[jj]
                lo, hi = (i, j) if i < j else (j, i)
                if hi - lo < 2 or (lo == 0 and hi == n - 1):
                    continue
                if best is not None and (lo, hi) >= best[:2]:
                    continue
                x = _cross_point(pts[lo], pts[(lo + 1) % n], pts[hi], pts[(hi + 1) % n])
                if x is not None:
                    best = (lo, hi, x)
    return best


def _split_loops(pts):
    """Separa um caminho que se cruza em laços simples (iterativo: formas com muitos cantos)."""
    out, stack, guard = [], [pts], 0
    while stack:
        cur = stack.pop()
        if len(cur) < 3:
            continue
        guard += 1
        hit = _first_crossing(cur) if guard < 20000 else None
        if hit is None:
            out.append(cur)
            continue
        i, j, x = hit
        stack.append([x] + cur[i + 1:j + 1])
        stack.append([x] + cur[j + 1:] + cur[:i + 1])
    return out


def offset(ring, d):
    """Anéis a distância |d| do anel: d > 0 para fora, d < 0 para dentro. Devolve anéis anti-horários.

    Desloca cada aresta, arredonda os cantos do lado que abre e desfaz os laços que se cruzam;
    sobram só os laços na orientação certa e longe do contorno pelo menos |d|.
    """
    r = clean(ring)
    if len(r) < 3:
        return []
    if area(r) < 0:
        r = r[::-1]
    if abs(d) < EPS:
        return [r]
    n = len(r)
    raw = []
    for i in range(n):
        p0, p1, p2 = r[i - 1], r[i], r[(i + 1) % n]
        e1 = (p1[0] - p0[0], p1[1] - p0[1])
        e2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        n1 = (e1[1] / l1, -e1[0] / l1)       # normal para fora (anel anti-horário)
        n2 = (e2[1] / l2, -e2[0] / l2)
        cr = e1[0] * e2[1] - e1[1] * e2[0]
        dot = e1[0] * e2[0] + e1[1] * e2[1]
        if cr * d <= 0:                        # canto que fecha: canto vivo (miter) quando não é agudo demais
            k = 1 + n1[0] * n2[0] + n1[1] * n2[1]
            if k > 0.2:
                raw.append((p1[0] + d * (n1[0] + n2[0]) / k, p1[1] + d * (n1[1] + n2[1]) / k))
                continue
        raw.append((p1[0] + d * n1[0], p1[1] + d * n1[1]))
        if cr * d > 0:                         # canto que abre: arco em volta do vértice
            turn = math.atan2(cr, dot)
            steps = max(1, int(abs(turn) / ARC_STEP))
            a0 = math.atan2(d * n1[1], d * n1[0])
            for k in range(1, steps):
                a = a0 + turn * k / steps
                raw.append((p1[0] + abs(d) * math.cos(a), p1[1] + abs(d) * math.sin(a)))
        raw.append((p1[0] + d * n2[0], p1[1] + d * n2[1]))
    loops = []
    for lp in _split_loops(clean(raw)):
        lp = clean(lp)
        if len(lp) < 3 or area(lp) <= 1e-6:
            continue
        # laço espúrio: algum ponto chega mais perto do contorno do que o raio da ferramenta
        probe = lp[:: max(1, len(lp) // 12)]
        if min(ring_dist(p, r) for p in probe) < abs(d) * 0.98:
            continue
        loops.append(lp)
    return loops


# ---------------------------------------------------------------- caminhos

def _resample(loop, cuts):
    """Insere pontos nas distâncias (ao longo do laço fechado) pedidas, para as micro-juntas."""
    out = [loop[0]]
    pos = 0.0
    cuts = sorted(c for c in cuts if c > 0)
    k = 0
    pts = loop + [loop[0]]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        L = math.dist(a, b)
        while k < len(cuts) and cuts[k] < pos + L - 1e-9:
            t = (cuts[k] - pos) / L if L > EPS else 0
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
            k += 1
        out.append(b)
        pos += L
    return out  # aberto: termina no ponto inicial


def _rotate_to(loop, near):
    i = min(range(len(loop)), key=lambda k: math.dist(loop[k], near))
    return loop[i:] + loop[:i]


def profile_moves(loop, z_from, depths, feed, plunge, ramp, tabs=None):
    """Passadas num laço fechado: rampa ao longo do caminho em cada descida, volta completa,
    e reforço do trecho da rampa. tabs: (lista de (início, fim) em mm ao longo do laço, z do topo da junta)."""
    P = length(loop)
    tab_iv, tab_z = tabs if tabs else ([], None)
    marks = [c for iv in tab_iv for c in iv]
    if ramp > 0:
        marks.append(min(ramp, P * 0.95))
    path = _resample(loop, marks)
    cum = [0.0]
    for i in range(1, len(path)):
        cum.append(cum[-1] + math.dist(path[i - 1], path[i]))

    def in_tab(s0, s1):
        mid = (s0 + s1) / 2
        return any(a - 1e-6 <= mid <= b + 1e-6 for a, b in tab_iv)

    moves = []          # (x, y, z, feed)
    zc = z_from
    L = min(ramp, P * 0.95) if ramp > 0 else 0
    for zt in depths:
        for k in range(1, len(path)):
            s = cum[k]
            z = zt if L <= 0 or s >= L else zc + (zt - zc) * s / L
            if tab_z is not None and z < tab_z and in_tab(cum[k - 1], s):
                z = tab_z
            f = plunge if (L > 0 and s <= L and zt < zc) else feed
            moves.append((path[k][0], path[k][1], z, f))
        if L > 0 and zt == depths[-1]:   # a última rampa deixou uma cunha: repassa o começo no fundo
            for k in range(1, len(path)):
                if cum[k] > L + 1e-9:
                    break
                z = zt
                if tab_z is not None and z < tab_z and in_tab(cum[k - 1], cum[k]):
                    z = tab_z
                moves.append((path[k][0], path[k][1], z, feed))
        zc = zt
    return path[0], moves


def pass_depths(total, step):
    n = max(1, math.ceil(total / step - 1e-9))
    return [-total * (k + 1) / n for k in range(n)]


def tab_intervals(P, count, width):
    if count <= 0 or width <= 0 or P < count * width * 3:
        return []
    gap = P / count
    return [(gap * k + gap / 2 - width / 2, gap * k + gap / 2 + width / 2) for k in range(count)]


# ---------------------------------------------------------------- configuração

def _num(obj, key, lo, hi, default=None):
    v = obj.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise CamError("Valor inválido em '%s'." % key)
    if not math.isfinite(v) or v < lo or v > hi:
        raise CamError("'%s' fora do intervalo (%g a %g): %g" % (key, lo, hi, v))
    return v


def read_tools(cfg):
    tools = {}
    for t in cfg.get("tools") or []:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("id", ""))[:40]
        if not tid:
            continue
        tools[tid] = {
            "id": tid,
            "name": str(t.get("name", "Ferramenta"))[:80],
            "kind": t.get("kind") if t.get("kind") in ("fresa", "broca") else "fresa",
            "dia": _num(t, "dia", 0.1, 100),
            "num": int(_num(t, "num", 1, 99, 1)),
            "rpm": _num(t, "rpm", 100, 60000),
            "feed": _num(t, "feed", 1, 60000),
            "plunge": _num(t, "plunge", 1, 60000),
            "step": _num(t, "step", 0.05, 100),
            "stepover": _num(t, "stepover", 5, 95, 40),
        }
    return tools


def read_cfg(cfg):
    if not isinstance(cfg, dict):
        raise CamError("Configuração de usinagem ausente.")
    m = cfg.get("machine") or {}
    s = cfg.get("strategy") or {}
    tools = read_tools(cfg)
    post = dict(DEFAULT_POST)
    for k in ("name", "ext", "header", "toolchange", "spindle", "footer"):
        if isinstance((cfg.get("post") or {}).get(k), str):
            post[k] = cfg["post"][k][:4000]
    post["comments"] = bool((cfg.get("post") or {}).get("comments", post["comments"]))
    post["ext"] = "".join(c for c in post["ext"] if c.isalnum())[:6] or "nc"
    mach = {
        "safe": _num(m, "safe", 1, 200, 15),
        "over": _num(m, "over", 0, 5, 0.2),
        "rapid": _num(m, "rapid", 100, 100000, 12000),
        "home_x": _num(m, "home_x", -10000, 10000, 0),
        "home_y": _num(m, "home_y", -10000, 10000, 0),
        "zero": "mesa" if m.get("zero") == "mesa" else "topo",
        "atc": bool(m.get("atc", False)),
    }
    def tool(key):
        tid = str(s.get(key) or "")
        return tools.get(tid)
    strat = {
        "profile": tool("profile_tool"),
        "pocket": tool("pocket_tool") or tool("profile_tool"),
        "climb": s.get("dir", "climb") != "conv",
        "ramp": _num(s, "ramp", 0, 500, 40),
        "tabs": bool(s.get("tabs", True)),
        "tab_area": _num(s, "tab_area", 0, 1e8, 15000),   # mm²: só peças menores levam micro-junta (0 = todas)
        "tab_count": int(_num(s, "tab_count", 0, 20, 2)),
        "tab_w": _num(s, "tab_w", 0.5, 50, 6),
        "tab_h": _num(s, "tab_h", 0.2, 50, 2),
        "drill": bool(s.get("drill", True)),
        "peck": _num(s, "peck", 0, 100, 0),
        "small_first": bool(s.get("small_first", True)),
    }
    if not strat["profile"]:
        raise CamError("Escolha a ferramenta de contorno na estratégia.")
    return mach, tools, strat, post


# ---------------------------------------------------------------- operações de uma chapa

def plan_sheet(sheet, mach, tools, strat):
    """Lista de operações [{tool, kind, start, moves|holes, ...}] já na ordem de corte e avisos."""
    th = _num(sheet, "th", 0.1, 300)
    W = _num(sheet, "w", 1, 100000)
    H = _num(sheet, "h", 1, 100000)
    through = th + mach["over"]
    prof = strat["profile"]
    r = prof["dia"] / 2
    drills = sorted((t for t in tools.values()), key=lambda t: (t["kind"] != "broca", t["dia"]))
    warns = []
    drill_ops, pocket_ops, inner_ops, outer_ops = [], [], [], []
    total_pts = 0

    def drill_tool(dia):
        if not strat["drill"]:
            return None
        for t in drills:
            if abs(t["dia"] - dia) <= 0.2:
                return t
        return None

    parts = sheet.get("parts") or []
    for pi, part in enumerate(parts):
        rings = part.get("rings") or []
        if not rings:
            continue
        outer = rings[0]
        total_pts += sum(len(x) for x in rings)
        if total_pts > MAX_POINTS:
            raise CamError("Chapa com pontos demais para usinar (%d)." % total_pts)
        # furos passantes: broca do mesmo diâmetro fura; senão contorno por dentro
        for hole in rings[1:]:
            c = circle_of(hole)
            t = drill_tool(c[2] * 2) if c else None
            if t:
                drill_ops.append({"tool": t, "kind": "furo", "at": (c[0], c[1]), "depth": through})
                continue
            loops = offset(hole, -r)
            if not loops:
                warns.append("Peça %d: furo menor que a fresa de contorno (%.1f mm) ficou sem usinar." % (pi + 1, prof["dia"]))
                continue
            for lp in loops:
                inner_ops.append({"tool": prof, "kind": "interno", "loop": lp if strat["climb"] else lp[::-1],
                                  "depth": through, "tabs": None})
        # rebaixos e furos cegos (camadas REBAIXO_x / FURO_x)
        for pk in part.get("pockets") or []:
            ring, dep, kind = pk.get("r") or [], float(pk.get("d") or 0), pk.get("k", "rebaixo")
            if len(ring) < 3 or not (0 < dep <= th):
                warns.append("Peça %d: rebaixo com profundidade inválida (%.2f mm) ignorado." % (pi + 1, dep))
                continue
            if kind == "furo":
                c = circle_of(ring)
                t = drill_tool(c[2] * 2) if c else None
                if t:
                    drill_ops.append({"tool": t, "kind": "furo", "at": (c[0], c[1]), "depth": dep})
                    continue
            pt = strat["pocket"]
            pr = pt["dia"] / 2
            step = pt["dia"] * pt["stepover"] / 100
            rings_in, d = [], -pr
            while True:
                level = offset(ring, d)
                if not level:
                    break
                rings_in.append(level)
                d -= step
                if len(rings_in) > 2000:
                    break
            if not rings_in:
                warns.append("Peça %d: rebaixo menor que a fresa (%.1f mm) ficou sem usinar." % (pi + 1, pt["dia"]))
                continue
            loops = [lp for level in reversed(rings_in) for lp in level]   # de dentro para fora
            pocket_ops.append({"tool": pt, "kind": "rebaixo", "loops": loops if strat["climb"] else [l[::-1] for l in loops],
                               "depth": dep})
        loops = offset(outer, r)
        if not loops:
            warns.append("Peça %d: contorno externo não pôde ser calculado." % (pi + 1))
            continue
        lp = max(loops, key=area)
        a = abs(area(outer)) - sum(abs(area(h)) for h in rings[1:])
        tabs = None
        if strat["tabs"] and strat["tab_count"] and (strat["tab_area"] == 0 or a < strat["tab_area"]):
            if strat["tab_h"] < th:
                tabs = (tab_intervals(length(lp), strat["tab_count"], strat["tab_w"] + prof["dia"]), -(th - strat["tab_h"]))
        outer_ops.append({"tool": prof, "kind": "externo", "loop": lp[::-1] if strat["climb"] else lp,
                          "depth": through, "tabs": tabs, "area": a})
        for x, y in lp:
            if x < -r - 1 or y < -r - 1 or x > W + r + 1 or y > H + r + 1:
                warns.append("Peça %d: caminho sai da chapa." % (pi + 1))
                break

    # vácuo: furos, rebaixos e contornos internos antes; peças pequenas antes das grandes
    if strat["small_first"]:
        outer_ops.sort(key=lambda o: o["area"])
    ops = drill_ops + pocket_ops + inner_ops + outer_ops
    # mesma ferramenta junta (troca automática ou um arquivo por ferramenta), na ordem de primeiro uso
    order = []
    for o in ops:
        if o["tool"]["id"] not in order:
            order.append(o["tool"]["id"])
    ops.sort(key=lambda o: order.index(o["tool"]["id"]))
    return ops, warns, th


# ---------------------------------------------------------------- G-code

class Emitter:
    def __init__(self, mach, th):
        self.lines = []
        self.pos = None
        self.f = None
        self.zoff = th if mach["zero"] == "mesa" else 0.0
        self.safe = mach["safe"]
        self.rapid = mach["rapid"]
        self.cut_len = 0.0
        self.rapid_len = 0.0
        self.time = 0.0
        self.preview = []          # [{op, pts}]

    @staticmethod
    def n(v):
        s = "%.3f" % v
        s = s.rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    def _go(self, code, x, y, z, f=None):
        z += self.zoff
        p = (x, y, z)
        parts = [code]
        old = self.pos
        for ax, v, i in (("X", x, 0), ("Y", y, 1), ("Z", z, 2)):
            if old is None or abs(old[i] - v) > 5e-4:
                parts.append(ax + self.n(v))
        if len(parts) == 1:
            return
        if f is not None and f != self.f:
            parts.append("F" + self.n(f))
            self.f = f
        self.lines.append(" ".join(parts))
        if old is not None:
            d = math.dist(old, p)
            if code == "G0":
                self.rapid_len += d
                self.time += d / self.rapid
            else:
                self.cut_len += d
                self.time += d / (f or self.f or 1000)
        self.pos = p

    def rapid_to(self, x, y):
        if self.pos is None:   # posição desconhecida (início, troca de ferramenta): sobe antes de andar
            self.lines.append("G0 Z" + self.n(self.safe + self.zoff))
            self.lines.append("G0 X%s Y%s" % (self.n(x), self.n(y)))
            self.pos = (x, y, self.safe + self.zoff)
            return
        if abs(self.pos[2] - (self.safe + self.zoff)) > 5e-4:
            self._go("G0", self.pos[0], self.pos[1], self.safe)
        self._go("G0", x, y, self.safe)

    def retract(self):
        if self.pos is not None:
            self._go("G0", self.pos[0], self.pos[1], self.safe)

    def cut(self, x, y, z, f):
        self._go("G1", x, y, z, f)


def _fill(tpl, vals):
    out = tpl
    for k, v in vals.items():
        out = out.replace("{" + k + "}", v)
    return out


def _tool_vals(t, mach, em):
    return {"T": str(t["num"]), "RPM": em.n(t["rpm"]), "TOOLNAME": t["name"], "DIA": em.n(t["dia"]),
            "SAFEZ": em.n(mach["safe"] + em.zoff), "HOMEX": em.n(mach["home_x"]), "HOMEY": em.n(mach["home_y"])}


def _emit_op(em, op):
    t = op["tool"]
    top = 0.0
    approach = top + 2.0   # desce rápido até 2 mm acima do material
    if op["kind"] == "furo":
        x, y = op["at"]
        em.rapid_to(x, y)
        em._go("G0", x, y, approach)
        depth = -op["depth"]
        step = op.get("peck") or 0
        z = top
        while True:
            z = max(depth, z - step) if step > 0 else depth
            em.cut(x, y, z, t["plunge"])
            if z <= depth + 1e-9:
                break
            em._go("G0", x, y, approach)
            em._go("G0", x, y, z + 0.5)
        em.preview.append({"op": "furo", "pts": [[x, y]], "r": t["dia"] / 2})
        em.retract()
        return
    loops = op["loops"] if op["kind"] == "rebaixo" else [op["loop"]]
    depths = pass_depths(op["depth"], t["step"])
    for lp in loops:
        here = em.pos[:2] if em.pos else lp[0]
        lp = _rotate_to(lp, here)
        tabs = op.get("tabs")
        start, moves = profile_moves(lp, top, depths, t["feed"], t["plunge"], op.get("ramp", 0), tabs)
        em.rapid_to(*start)
        em._go("G0", start[0], start[1], approach)
        em.cut(start[0], start[1], top, t["plunge"])
        for x, y, z, f in moves:
            em.cut(x, y, z, f)
        em.retract()
        em.preview.append({"op": op["kind"], "pts": [[round(p[0], 3), round(p[1], 3)] for p in lp],
                           "tabs": [list(iv) for iv in (tabs[0] if tabs else [])]})


def gcode_sheet(sheet, cfg):
    """G-code de uma chapa: um arquivo (troca automática) ou um por ferramenta (troca manual)."""
    mach, tools, strat, post = read_cfg(cfg)
    ops, warns, th = plan_sheet(sheet, mach, tools, strat)
    for o in ops:
        o["ramp"] = strat["ramp"] if o["kind"] != "furo" else 0
        if o["kind"] == "furo":
            o["peck"] = strat["peck"]
    groups = []
    for o in ops:
        if not groups or groups[-1][0]["id"] != o["tool"]["id"]:
            groups.append((o["tool"], []))
        groups[-1][1].append(o)

    files = []
    preview = []
    stats = {"cut_m": 0.0, "rapid_m": 0.0, "minutes": 0.0, "tools": []}

    def head(em, title):
        vals = _tool_vals(groups[0][0] if groups else strat["profile"], mach, em)
        if post["comments"]:
            em.lines.append("(%s)" % title.replace("(", "[").replace(")", "]"))
        em.lines.extend(x for x in _fill(post["header"], vals).splitlines() if x.strip())

    def foot(em, t):
        em.lines.extend(x for x in _fill(post["footer"], _tool_vals(t, mach, em)).splitlines() if x.strip())

    def body(em, t, oplist, change):
        vals = _tool_vals(t, mach, em)
        if post["comments"]:
            em.lines.append("(T%d %s D%s)" % (t["num"], t["name"].replace("(", "[").replace(")", "]"), em.n(t["dia"])))
        em.lines.extend(x for x in _fill(post["toolchange"] if change else post["spindle"], vals).splitlines() if x.strip())
        em.pos = None if change else em.pos
        for o in oplist:
            _emit_op(em, o)

    if mach["atc"] or len(groups) <= 1:
        em = Emitter(mach, th)
        head(em, sheet.get("name", "chapa"))
        for t, oplist in groups:
            body(em, t, oplist, mach["atc"])
        foot(em, groups[-1][0] if groups else strat["profile"])
        files.append({"suffix": "", "gcode": "\n".join(em.lines) + "\n"})
        if not mach["atc"] and groups:   # sem T M06 no arquivo: a simulação sabe a ferramenta por aqui
            files[-1]["num"] = groups[0][0]["num"]
        ems = [em]
    else:
        ems = []
        for k, (t, oplist) in enumerate(groups):
            em = Emitter(mach, th)
            head(em, "%s - ferramenta %d de %d: %s" % (sheet.get("name", "chapa"), k + 1, len(groups), t["name"]))
            body(em, t, oplist, False)
            foot(em, t)
            files.append({"suffix": "_%d_T%d" % (k + 1, t["num"]), "gcode": "\n".join(em.lines) + "\n", "tool": t["name"], "num": t["num"]})
            ems.append(em)
    for em in ems:
        stats["cut_m"] += em.cut_len / 1000
        stats["rapid_m"] += em.rapid_len / 1000
        stats["minutes"] += em.time
        preview.extend(em.preview)
    stats["tools"] = [{"num": t["num"], "name": t["name"], "dia": t["dia"], "ops": len(o)} for t, o in groups]
    stats = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in stats.items()}
    return {"files": files, "warnings": warns, "stats": stats, "preview": preview, "ext": post["ext"]}
