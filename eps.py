"""Exportação EPS (PostScript encapsulado) de chapas encaixadas, com validação por releitura.

Cada chapa vira um EPS de uma página. Unidade de entrada: mm. Saída: pontos (1 pt = 25,4/72 mm).
O BoundingBox é sempre o tamanho real da chapa. O eixo Y é invertido para o desenho sair como na tela
(origem no canto superior esquerdo da chapa na tela, inferior esquerdo no PostScript).
Só há linhas retas: as curvas chegam ao servidor já como polilinhas (limitação do importador atual).
"""

from __future__ import annotations

import math
import re

PT_PER_MM = 72.0 / 25.4
TOL_MM = 0.01


def _pt(mm: float) -> float:
    return mm * PT_PER_MM


def _num(v: float) -> str:
    s = "%.5f" % v
    return s.rstrip("0").rstrip(".") if "." in s else s


def _hex_rgb(value: str):
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        n = int(value[1:], 16)
        return (n >> 16) / 255.0, ((n >> 8) & 255) / 255.0, (n & 255) / 255.0
    return 0.0, 0.0, 0.0


def check_sheet(sheet: dict) -> None:
    w, h = float(sheet["w"]), float(sheet["h"])
    if not (math.isfinite(w) and math.isfinite(h)) or w <= 0 or h <= 0:
        raise ValueError("Chapa com medidas inválidas.")
    for part in sheet.get("parts", []):
        for ring in part["rings"]:
            if len(ring) < 3:
                raise ValueError("Contorno com menos de 3 pontos.")
            for x, y in ring:
                if not (math.isfinite(x) and math.isfinite(y)):
                    raise ValueError("Coordenada inválida em um contorno.")


def build_eps(sheet: dict, title: str = "Encaixe", use_colors: bool = False, frame: bool = False,
              line_pt: float = 0.25) -> str:
    """sheet = {w, h, parts:[{rings:[[[x,y],...],...], color:'#rrggbb'}]}; coordenadas em mm, Y para baixo."""
    check_sheet(sheet)
    w, h = float(sheet["w"]), float(sheet["h"])
    W, H = _pt(w), _pt(h)
    safe_title = re.sub(r"[^\w .-]", "_", title)[:80]
    out = [
        "%!PS-Adobe-3.0 EPSF-3.0",
        "%%%%Title: %s" % safe_title,
        "%%Creator: Encaixe/Chapa",
        "%%%%BoundingBox: 0 0 %d %d" % (math.ceil(W - 1e-9), math.ceil(H - 1e-9)),
        "%%%%HiResBoundingBox: 0 0 %s %s" % (_num(W), _num(H)),
        "%%Pages: 1",
        "%%EndComments",
        "%%Page: 1 1",
        "/m{moveto}def /l{lineto}def /h{closepath}def",
        "%s setlinewidth 1 setlinejoin 0 setlinecap" % _num(line_pt),
    ]
    if frame:
        out += ["0.5 setgray", "0 0 m %s 0 l %s %s l 0 %s l h stroke" % (_num(W), _num(W), _num(H), _num(H))]
    cutcount = 0
    for part in sheet.get("parts", []):
        r, g, b = _hex_rgb(part.get("color")) if use_colors else (0.0, 0.0, 0.0)
        out.append("%s %s %s setrgbcolor" % (_num(r), _num(g), _num(b)))
        out.append("newpath")
        for ring in part["rings"]:
            pts = [(_pt(x), H - _pt(y)) for x, y in ring]
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            out.append("%s %s m" % (_num(pts[0][0]), _num(pts[0][1])))
            for x, y in pts[1:]:
                out.append("%s %s l" % (_num(x), _num(y)))
            out.append("h")
            cutcount += 1
        out.append("stroke")
    out += ["showpage", "%%Trailer", "%%EOF", ""]
    return "\n".join(out)


def parse_eps(text: str) -> dict:
    """Releitura independente: cabeçalho, BoundingBox, contornos (em mm, Y para baixo)."""
    lines = text.splitlines()
    info = {"header": bool(lines) and lines[0].startswith("%!PS-Adobe-3.0 EPSF-3.0"), "eof": "%%EOF" in text,
            "bbox": None, "hires": None, "rings": []}
    for ln in lines:
        if ln.startswith("%%BoundingBox:"):
            info["bbox"] = [int(v) for v in ln.split(":", 1)[1].split()]
        elif ln.startswith("%%HiResBoundingBox:"):
            info["hires"] = [float(v) for v in ln.split(":", 1)[1].split()]
    H = info["hires"][3] if info["hires"] else 0.0
    cur = None
    for ln in lines:
        t = ln.split()
        if len(t) == 3 and t[2] == "m":
            cur = [(float(t[0]), float(t[1]))]
        elif len(t) == 3 and t[2] == "l" and cur is not None:
            cur.append((float(t[0]), float(t[1])))
        elif t == ["h"] and cur is not None:
            info["rings"].append([(x / PT_PER_MM, (H - y) / PT_PER_MM) for x, y in cur])
            cur = None
        elif len(t) > 3 and t[-1] == "stroke" and t[-2] == "h" and len(t) == 12:
            pass  # moldura: ignorada na releitura dos cortes
    return info


def validate(text: str, sheet: dict, tol_mm: float = TOL_MM) -> dict:
    """Compara o EPS gerado com a chapa de origem. Falha se contagem, contornos ou medidas diferirem."""
    issues = []
    info = parse_eps(text)
    if not info["header"]:
        issues.append("Cabeçalho EPS ausente.")
    if not info["eof"]:
        issues.append("Final do arquivo (%%EOF) ausente.")
    if not info["hires"]:
        issues.append("BoundingBox ausente.")
    else:
        bw, bh = info["hires"][2] / PT_PER_MM, info["hires"][3] / PT_PER_MM
        if abs(bw - sheet["w"]) > tol_mm or abs(bh - sheet["h"]) > tol_mm:
            issues.append("Medida da chapa difere: %.3f×%.3f mm." % (bw, bh))
    expected = [r for p in sheet.get("parts", []) for r in p["rings"]]
    if len(info["rings"]) != len(expected):
        issues.append("Contornos: esperados %d, lidos %d." % (len(expected), len(info["rings"])))
    else:
        worst = 0.0
        for got, want in zip(info["rings"], expected):
            want = want[:-1] if want[0] == want[-1] else want
            if len(got) != len(want):
                issues.append("Contorno com número de pontos diferente.")
                break
            for (gx, gy), (wx, wy) in zip(got, want):
                worst = max(worst, abs(gx - wx), abs(gy - wy))
        if worst > tol_mm:
            issues.append("Desvio máximo de %.4f mm acima da tolerância." % worst)
        info["max_dev_mm"] = worst
    return {"ok": not issues, "issues": issues, "rings": len(info["rings"]), "bbox_mm":
            [round(info["hires"][2] / PT_PER_MM, 3), round(info["hires"][3] / PT_PER_MM, 3)] if info["hires"] else None,
            "max_dev_mm": info.get("max_dev_mm", 0.0)}
