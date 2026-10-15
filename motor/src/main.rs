//! Motor de encaixe compilado. Mesmo método do nest.py:
//! cada orientação da peça vira uma máscara em grade, a chapa é uma grade de bits,
//! a posição escolhida é a mais à esquerda e uma busca local troca a ordem das peças
//! até o prazo acabar. Furos e reentrâncias ficam livres na máscara, então peças
//! menores entram dentro das maiores.
//!
//! Uso: lê de stdin o mesmo JSON de /api/nest e escreve o resultado em stdout.

mod json;

use json::J;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Ligado quando o usuário pede para parar: as buscas terminam e fica o melhor até ali.
static STOP: AtomicBool = AtomicBool::new(false);

fn stopped() -> bool {
    STOP.load(Ordering::Relaxed)
}

type Pt = (f64, f64);
type Ring = Vec<Pt>;

// ---------- geometria ----------

fn transform(rings: &[Ring], ang: f64, mir: bool) -> (Vec<Ring>, f64, f64) {
    let a = ang.to_radians();
    let (s, c) = (a.sin(), a.cos());
    let mut out: Vec<Ring> = Vec::with_capacity(rings.len());
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for r in rings {
        let mut pts = Vec::with_capacity(r.len());
        for &(px, y) in r {
            let x = if mir { -px } else { px };
            let p = (x * c - y * s, x * s + y * c);
            x0 = x0.min(p.0);
            y0 = y0.min(p.1);
            x1 = x1.max(p.0);
            y1 = y1.max(p.1);
            pts.push(p);
        }
        out.push(pts);
    }
    for r in out.iter_mut() {
        for p in r.iter_mut() {
            *p = (p.0 - x0, p.1 - y0);
        }
    }
    (out, x1 - x0, y1 - y0)
}

fn hull(pts: &[Pt]) -> Vec<Pt> {
    let mut p: Vec<Pt> = pts.to_vec();
    p.sort_by(|a, b| a.partial_cmp(b).unwrap());
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    fn half(seq: &mut dyn Iterator<Item = Pt>) -> Vec<Pt> {
        let mut h: Vec<Pt> = Vec::new();
        for q in seq {
            while h.len() >= 2 {
                let (a, b) = (h[h.len() - 2], h[h.len() - 1]);
                if (b.0 - a.0) * (q.1 - a.1) - (b.1 - a.1) * (q.0 - a.0) <= 0.0 {
                    h.pop();
                } else {
                    break;
                }
            }
            h.push(q);
        }
        h
    }
    let mut lo = half(&mut p.iter().copied());
    let mut up = half(&mut p.iter().rev().copied());
    lo.pop();
    up.pop();
    lo.extend(up);
    lo
}

/// Ângulos que deitam um lado do casco convexo sobre o eixo X.
fn hull_angles(ring: &[Pt]) -> Vec<f64> {
    let (n_long, n_area) = (3usize, 3usize);
    let h = hull(ring);
    if h.len() < 3 {
        return Vec::new();
    }
    let mut edges: Vec<(f64, f64)> = Vec::new();
    for i in 0..h.len() {
        let (a, b) = (h[i], h[(i + 1) % h.len()]);
        let l = (b.0 - a.0).hypot(b.1 - a.1);
        if l > 1e-6 {
            edges.push((l, (-(b.1 - a.1).atan2(b.0 - a.0).to_degrees()).rem_euclid(360.0)));
        }
    }
    edges.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let mut out: Vec<f64> = edges.iter().take(n_long).map(|e| e.1).collect();
    let mut scored: Vec<(f64, f64)> = Vec::new();
    for &(_, ang) in edges.iter().take(n_long.max(24)) {
        let (c, s) = (ang.to_radians().cos(), ang.to_radians().sin());
        let (mut ax, mut bx, mut ay, mut by) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in &h {
            let (x, y) = (p.0 * c - p.1 * s, p.0 * s + p.1 * c);
            ax = ax.min(x);
            bx = bx.max(x);
            ay = ay.min(y);
            by = by.max(y);
        }
        scored.push(((bx - ax) * (by - ay), ang));
    }
    scored.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out.extend(scored.iter().take(n_area).map(|e| e.1));
    let more: Vec<f64> = out.iter().map(|a| (a + 180.0).rem_euclid(360.0)).collect();
    out.extend(more);
    out
}

fn round2(a: f64) -> f64 {
    format!("{:.2}", a).parse().unwrap_or(a)
}

fn sorted_set(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.dedup();
    v
}

/// rot: passo global em graus (-1 = livre 360°, 0 = sem giro). mode: auto|free|90|180|0.
fn angle_set(rings: &[Ring], rot: i64, mode: &str) -> Vec<f64> {
    match mode {
        "0" => return vec![0.0],
        "180" => return vec![0.0, 180.0],
        "90" => return vec![0.0, 90.0, 180.0, 270.0],
        _ => {}
    }
    let free = mode == "free" || rot == -1;
    let step = if free { 15 } else { rot };
    if step <= 0 {
        return vec![0.0];
    }
    let mut angs: Vec<f64> = (0..360).step_by(step as usize).map(|a| a as f64).collect();
    if free && !rings.is_empty() {
        angs.extend(hull_angles(&rings[0]).into_iter().map(round2));
    }
    sorted_set(angs)
}

fn refine(a: f64) -> Vec<f64> {
    [-4.0, -2.0, 0.0, 2.0, 4.0].iter().map(|d| round2((a + d).rem_euclid(360.0))).collect()
}

// ---------- bits ----------

fn set_range(w: &mut [u64], lo: usize, hi: usize) {
    // liga os bits lo..=hi
    let (a, b) = (lo / 64, hi / 64);
    let first = !0u64 << (lo % 64);
    let last = !0u64 >> (63 - hi % 64);
    if a == b {
        w[a] |= first & last;
    } else {
        w[a] |= first;
        for x in &mut w[a + 1..b] {
            *x = !0;
        }
        w[b] |= last;
    }
}

fn any_in_range(w: &[u64], start: usize, len: usize, width: usize) -> bool {
    if start >= width || len == 0 {
        return false;
    }
    let hi = (start + len - 1).min(width - 1);
    let (a, b) = (start / 64, hi / 64);
    let first = !0u64 << (start % 64);
    let last = !0u64 >> (63 - hi % 64);
    if a == b {
        return w[a] & first & last != 0;
    }
    if w[a] & first != 0 || w[b] & last != 0 {
        return true;
    }
    w[a + 1..b].iter().any(|&x| x != 0)
}

/// Primeiro bit desligado em lo..limit.
fn first_zero(w: &[u64], lo: usize, limit: usize) -> Option<usize> {
    if lo >= limit {
        return None;
    }
    let mut i = lo / 64;
    let mut cur = !w[i] & (!0u64 << (lo % 64));
    loop {
        if cur != 0 {
            let x = i * 64 + cur.trailing_zeros() as usize;
            return if x < limit { Some(x) } else { None };
        }
        i += 1;
        if i * 64 >= limit {
            return None;
        }
        cur = !w[i];
    }
}

fn runs_of(w: &[u64], out: &mut Vec<(u32, u32)>) {
    out.clear();
    let total = w.len() * 64;
    let mut x = 0usize;
    while x < total {
        let i = x / 64;
        let cur = w[i] >> (x % 64);
        if cur == 0 {
            x = (i + 1) * 64;
            continue;
        }
        let s = x + cur.trailing_zeros() as usize;
        let mut e = s;
        loop {
            let j = e / 64;
            if j >= w.len() {
                break;
            }
            let ones = (!(w[j] >> (e % 64))).trailing_zeros() as usize;
            let room = 64 - e % 64;
            if ones >= room {
                e += room;
            } else {
                e += ones;
                break;
            }
        }
        out.push((s as u32, (e - s) as u32));
        x = e;
    }
}

// ---------- máscara da peça ----------

struct Mask {
    w: usize,
    h: usize,
    rows: Vec<(usize, Vec<(u32, u32)>)>,
    cells: u64,
    /// Ordem de teste de colisão: linhas espalhadas primeiro.
    scan: Vec<usize>,
}

fn merge(iv: &mut Vec<(i64, i64)>) {
    iv.sort();
    let mut out: Vec<(i64, i64)> = Vec::with_capacity(iv.len());
    for &(a, b) in iv.iter() {
        match out.last_mut() {
            Some(l) if a <= l.1 + 1 => l.1 = l.1.max(b),
            _ => out.push((a, b)),
        }
    }
    *iv = out;
}

fn build_mask(rings: &[Ring], w: f64, h: f64, cs: f64, r: usize) -> Mask {
    let ww = (w / cs).ceil() as i64 + 1 + 2 * r as i64;
    let hh = (h / cs).ceil() as i64 + 1 + 2 * r as i64;
    let rf = r as f64;
    let mut cross: Vec<Vec<f64>> = vec![Vec::new(); hh as usize];
    for q in rings {
        let n = q.len();
        for i in 0..n {
            let (a, b) = (q[i], q[(i + 1) % n]);
            let (lo, hi) = if a.1 < b.1 { (a.1, b.1) } else { (b.1, a.1) };
            if lo == hi {
                continue;
            }
            let mut y = ((lo / cs + rf - 0.5).ceil() as i64 - 1).max(0);
            let y1 = ((hi / cs + rf - 0.5).floor() as i64 + 1).min(hh - 1);
            while y <= y1 {
                let yy = (y as f64 - rf + 0.5) * cs;
                if (a.1 > yy) != (b.1 > yy) {
                    cross[y as usize].push(a.0 + (yy - a.1) / (b.1 - a.1) * (b.0 - a.0));
                }
                y += 1;
            }
        }
    }
    // Além do miolo (linha no centro de cada faixa), marca toda célula que o contorno
    // toca: assim a máscara sempre cobre a peça inteira, inclusive pontas agudas que
    // passariam entre duas linhas, e a folga pedida vira um mínimo de verdade.
    let mut edge: Vec<Vec<(i64, i64)>> = vec![Vec::new(); hh as usize];
    let ri = r as i64;
    for q in rings {
        let n = q.len();
        for i in 0..n {
            let (a, b) = (q[i], q[(i + 1) % n]);
            let (lo, hi) = if a.1 < b.1 { (a.1, b.1) } else { (b.1, a.1) };
            let mut y = ((lo / cs).floor() as i64 + ri).max(0);
            let y1 = ((hi / cs).floor() as i64 + ri).min(hh - 1);
            while y <= y1 {
                let (xa, xb) = if lo == hi {
                    (a.0, b.0)
                } else {
                    let b0 = (y - ri) as f64 * cs;
                    let (ya, yb) = (lo.max(b0), hi.min(b0 + cs));
                    (a.0 + (ya - a.1) / (b.1 - a.1) * (b.0 - a.0), a.0 + (yb - a.1) / (b.1 - a.1) * (b.0 - a.0))
                };
                let x0 = ((xa.min(xb) / cs).floor() as i64 + ri).max(0);
                let x1 = ((xa.max(xb) / cs).floor() as i64 + ri).min(ww - 1);
                if x1 >= x0 {
                    edge[y as usize].push((x0, x1));
                }
                y += 1;
            }
        }
    }
    let mut rows: Vec<Vec<(i64, i64)>> = Vec::with_capacity(hh as usize);
    for (y, xs) in cross.iter_mut().enumerate() {
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut iv: Vec<(i64, i64)> = std::mem::take(&mut edge[y]);
        let mut k = 0;
        while k + 1 < xs.len() {
            let x0 = ((xs[k] / cs - 0.5).round_ties_even() as i64 + r as i64).max(0);
            let x1 = ((xs[k + 1] / cs - 0.5).round_ties_even() as i64 + r as i64).min(ww - 1);
            if x1 >= x0 {
                iv.push((x0, x1));
            }
            k += 2;
        }
        merge(&mut iv);
        rows.push(iv);
    }
    if r > 0 {
        let ri = r as i64;
        for iv in rows.iter_mut() {
            for e in iv.iter_mut() {
                *e = ((e.0 - ri).max(0), (e.1 + ri).min(ww - 1));
            }
            iv.retain(|e| e.1 >= e.0);
            merge(iv);
        }
        let src = rows.clone();
        for y in 0..hh as usize {
            let (a, b) = (y.saturating_sub(r), (y + r).min(hh as usize - 1));
            let mut iv: Vec<(i64, i64)> = Vec::new();
            for s in &src[a..=b] {
                iv.extend_from_slice(s);
            }
            merge(&mut iv);
            rows[y] = iv;
        }
    }
    let mut out: Vec<(usize, Vec<(u32, u32)>)> = Vec::new();
    let mut cells = 0u64;
    for (y, iv) in rows.iter().enumerate() {
        if iv.is_empty() {
            continue;
        }
        let runs: Vec<(u32, u32)> = iv.iter().map(|&(a, b)| (a as u32, (b - a + 1) as u32)).collect();
        cells += runs.iter().map(|x| x.1 as u64).sum::<u64>();
        out.push((y, runs));
    }
    let n = out.len();
    let bits = if n > 1 { usize::BITS - (n - 1).leading_zeros() } else { 1 }.max(1);
    let mut scan: Vec<usize> = (0..n).collect();
    scan.sort_by_key(|&i| (i as u64).reverse_bits() >> (64 - bits));
    Mask { w: ww as usize, h: hh as usize, rows: out, cells, scan }
}

// ---------- chapa ----------

#[derive(Clone, Copy, PartialEq)]
enum Memo {
    Unknown,
    At(usize, usize),
    Never,
}

#[derive(Clone)]
struct Placed {
    uid: usize,
    a: f64,
    mi: bool,
    x: f64,
    y: f64,
}

struct Sheet {
    w: usize,
    h: usize,
    nw: usize,
    occ: Vec<u64>,
    runs: Vec<Vec<(u32, u32)>>,
    dirty: Vec<bool>,
    filled: Vec<bool>,
    placed: Vec<Placed>,
    extent: usize,
    top: usize,
    used: u64,
    gids: HashSet<usize>,
    /// Por máscara: última posição achada, ou Never se já não cabe.
    /// A chapa só enche, então a melhor posição (gx, depois gy) nunca recua.
    memo: Vec<Memo>,
}

impl Sheet {
    fn new(w: usize, h: usize) -> Sheet {
        let nw = w / 64 + 1;
        Sheet {
            w,
            h,
            nw,
            occ: vec![0; nw * h],
            runs: vec![Vec::new(); h],
            dirty: vec![false; h],
            filled: vec![false; h],
            placed: Vec::new(),
            extent: 0,
            top: 0,
            used: 0,
            gids: HashSet::new(),
            memo: Vec::new(),
        }
    }

    fn row(&self, y: usize) -> &[u64] {
        &self.occ[y * self.nw..(y + 1) * self.nw]
    }

    fn fits(&self, m: &Mask, gx: usize, gy: usize) -> bool {
        for &ri in &m.scan {
            let (ry, ref runs) = m.rows[ri];
            let y = gy + ry;
            if !self.filled[y] {
                continue;
            }
            let row = self.row(y);
            for &(s, l) in runs {
                if any_in_range(row, gx + s as usize, l as usize, self.w) {
                    return false;
                }
            }
        }
        true
    }

    /// Melhor (gx, gy) mais à esquerda; cap limita gx para podar.
    fn find(&mut self, m: &Mask, cap: i64, last: Option<(usize, usize)>, forb: &mut Vec<u64>, e: usize) -> Option<(usize, usize)> {
        let maxx = (self.w as i64 - m.w as i64 - e as i64).min(cap - 1);
        if maxx < e as i64 || self.h < m.h + 2 * e {
            return None;
        }
        let maxx = maxx as usize;
        let ymax = self.h - m.h - e;
        let mut lo = e;
        if let Some((gx0, gy0)) = last {
            if gx0 > maxx {
                return None;
            }
            for gy in gy0.max(e)..=ymax {
                if self.fits(m, gx0, gy) {
                    return Some((gx0, gy));
                }
            }
            lo = gx0 + 1;
            if lo > maxx {
                return None;
            }
        }
        let mut best: Option<(usize, usize)> = None;
        forb.clear();
        forb.resize(self.nw + 1, 0);
        for gy in e..=ymax {
            let limit = match best {
                Some(b) => b.0,
                None => maxx + 1,
            };
            if limit <= lo {
                break;
            }
            let words = (limit - 1) / 64 + 1;
            for x in &mut forb[..words] {
                *x = 0;
            }
            let mut dead = false;
            for &ri in &m.scan {
                let (ry, ref mruns) = m.rows[ri];
                let y = gy + ry;
                if !self.filled[y] {
                    continue;
                }
                if self.dirty[y] {
                    let (a, b) = (y * self.nw, (y + 1) * self.nw);
                    let mut tmp = std::mem::take(&mut self.runs[y]);
                    runs_of(&self.occ[a..b], &mut tmp);
                    self.runs[y] = tmp;
                    self.dirty[y] = false;
                }
                let oruns = &self.runs[y];
                for &(s, l) in mruns {
                    let (s, l) = (s as i64, l as i64);
                    for &(a, len) in oruns {
                        // ocupado em [a, a+len): a peça bate se gx estiver em [a-s-l+1, a+len-s-1]
                        let hi = (a as i64 + len as i64 - s - 1).min(limit as i64 - 1);
                        let lo_f = (a as i64 - s - l + 1).max(lo as i64);
                        if lo_f <= hi {
                            set_range(&mut forb[..words], lo_f as usize, hi as usize);
                        }
                    }
                }
                if first_zero(&forb[..words], lo, limit).is_none() {
                    dead = true;
                    break;
                }
            }
            if dead {
                continue;
            }
            if let Some(gx) = first_zero(&forb[..words], lo, limit) {
                if best.map_or(true, |b| gx < b.0) {
                    best = Some((gx, gy));
                    if gx == lo {
                        break;
                    }
                }
            }
        }
        best
    }

    /// Ocupa a chapa com a peça. `big` é a mesma peça com folga maior (d células a mais
    /// de cada lado): o que passar da borda da chapa é cortado.
    fn put(&mut self, m: &Mask, big: &Mask, d: usize, gx: usize, gy: usize) {
        for (ry, runs) in &big.rows {
            let y = gy as i64 - d as i64 + *ry as i64;
            if y < 0 || y >= self.h as i64 {
                continue;
            }
            let y = y as usize;
            let (a, b) = (y * self.nw, (y + 1) * self.nw);
            for &(s, l) in runs {
                let lo = gx as i64 - d as i64 + s as i64;
                let hi = (lo + l as i64 - 1).min(self.w as i64 - 1);
                let lo = lo.max(0);
                if lo <= hi {
                    set_range(&mut self.occ[a..b], lo as usize, hi as usize);
                    self.filled[y] = true;
                    self.dirty[y] = true;
                }
            }
        }
        self.extent = self.extent.max(gx + m.w);
        self.used += m.cells;
        self.top = self.top.max(gy + m.h);
    }
}

// ---------- regras de conjunto ----------

#[derive(Default)]
struct Rules {
    mix: bool,
    isolate: HashSet<usize>,
    together: HashSet<usize>,
    forbid: Vec<(usize, usize)>,
}

/// True se a peça deste conjunto pode entrar nesta chapa.
fn allows(have: &HashSet<usize>, gid: usize, rules: &Rules) -> bool {
    let alone = have.is_empty() || (have.len() == 1 && have.contains(&gid));
    if rules.together.contains(&gid) {
        return alone;
    }
    if have.iter().any(|g| rules.together.contains(g)) {
        return false;
    }
    if rules.isolate.contains(&gid) || have.iter().any(|g| rules.isolate.contains(g)) {
        return alone;
    }
    if !rules.mix {
        return alone;
    }
    for &(a, b) in &rules.forbid {
        if (gid == a && have.contains(&b)) || (gid == b && have.contains(&a)) {
            return false;
        }
    }
    true
}

// ---------- encaixe de uma ordem ----------

struct Item {
    /// Peças com o mesmo id compartilham máscaras.
    tid: usize,
    rings: Vec<Ring>,
    area: f64,
    mirror: bool,
    gid: usize,
    angs: Vec<f64>,
    /// Espaço entre peças e margem da chapa desta peça (mm); sem valor próprio, os do encaixe.
    gap: f64,
    mar: f64,
    /// Produto da peça (0 = sem produto) e posição dele na ordem do planejamento.
    prod: usize,
    rank: i64,
}

/// Folga por peça. O encaixe roda com o menor espaço (r0, rb0); a peça com espaço maior
/// ganha células nas duas máscaras, e duas peças ficam sempre a pelo menos o maior dos
/// dois espaços: rb_a + r_b >= max(T_a, T_b). A margem própria vira recuo e da borda.
fn item_cells(it: &Item, opt: &Opt) -> (usize, usize, usize) {
    let t = (it.gap / opt.cs - 1e-9).ceil().max(0.0) as usize;
    let r = opt.r.max(t.saturating_sub(opt.rb));
    let rb = opt.rb.max(t.saturating_sub(opt.r));
    let e = ((it.mar - opt.mar) / opt.cs - 1e-9).ceil().max(0.0) as usize;
    (r, rb, e)
}

#[derive(Clone, Copy)]
struct Ent {
    uid: usize,
    gene: u8,
    fine: bool,
}

/// Folga em células para garantir `gap` mm reais entre duas peças.
///
/// A máscara cobre a peça inteira, então duas peças com T células livres entre elas
/// ficam a pelo menos T * cs mm. T é repartido entre a máscara que testa a posição (r)
/// e a que ocupa a chapa (rb); com T ímpar, rb = r + 1.
fn radii(gap: f64, cs: f64) -> (usize, usize) {
    let total = (gap / cs - 1e-9).ceil().max(0.0) as usize;
    (total / 2, total - total / 2)
}

struct Opt<'a> {
    cs: f64,
    mar: f64,
    r: usize,
    rb: usize,
    boxed: bool,
    rules: &'a Rules,
    /// Planejamento: encaixar os produtos na ordem da lista (rank) e manter cada produto
    /// na mesma chapa ou em chapas vizinhas (near).
    seq: bool,
    near: bool,
}

#[derive(Default)]
struct Cache {
    map: HashMap<(usize, u64, bool), usize>,
    masks: Vec<Mask>,
    /// Mesma peça com a folga maior, usada para ocupar a chapa (None quando rb == r).
    big: Vec<Option<Mask>>,
}

struct SheetOut {
    placed: Vec<Placed>,
    extent: usize,
}

struct Res {
    sheets: Vec<SheetOut>,
    fail: Vec<usize>,
    why: Vec<&'static str>,
}

type Score = (usize, usize, usize);

fn score(r: &Res) -> Score {
    (r.fail.len(), r.sheets.len(), r.sheets.last().map_or(0, |s| s.extent))
}

struct Cand {
    key: [u64; 3],
    a: f64,
    mi: bool,
    mask: usize,
    sp: (usize, usize),
}

fn pack(order: &[Ent], items: &[Item], fine: &[Vec<f64>], g: (f64, f64), opt: &Opt, cache: &mut Cache) -> Res {
    let cs = opt.cs;
    let wf = ((g.0 - 2.0 * opt.mar) / cs).floor();
    let hf = ((g.1 - 2.0 * opt.mar) / cs).floor();
    let mut fail: Vec<usize> = Vec::new();
    let mut why: Vec<&'static str> = Vec::new();
    if wf < 1.0 || hf < 1.0 {
        return Res { sheets: Vec::new(), fail: order.iter().map(|e| e.uid).collect(), why: vec!["tamanho"; order.len()] };
    }
    let (w, h) = (wf as usize, hf as usize);
    let rules = opt.rules;
    // ordem do planejamento: a busca troca peças à vontade, mas os produtos entram na sequência da lista
    let sorted: Vec<Ent>;
    let order: &[Ent] = if opt.seq {
        let mut v = order.to_vec();
        v.sort_by_key(|e| items[e.uid].rank);
        sorted = v;
        &sorted
    } else {
        order
    };
    let mut span: HashMap<usize, (usize, usize)> = HashMap::new();
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut opened: HashMap<usize, usize> = HashMap::new();
    let mut forb: Vec<u64> = Vec::new();
    let mut cands: Vec<Cand> = Vec::new();
    for e in order {
        let it = &items[e.uid];
        let (r, rb, edge) = item_cells(it, opt);
        let gid = it.gid;
        let angs: &[f64] = if e.fine { &fine[e.uid] } else { &it.angs };
        let gene = e.gene as usize;
        let tog = rules.together.contains(&gid);
        let mut placed = false;
        let n0 = sheets.len();
        // produto junto: primeiro as chapas onde ele já está, depois as vizinhas; o resto só se não couber
        let mut tries: Vec<usize> = Vec::with_capacity(n0 + 1);
        if let (true, Some(&(lo, hi))) = (opt.near && it.prod != 0, span.get(&it.prod)) {
            tries.extend(lo..=hi);
            tries.push(hi + 1);
            if lo > 0 {
                tries.push(lo - 1);
            }
            tries.retain(|&k| k <= n0);
            for k in 0..=n0 {
                if !tries.contains(&k) {
                    tries.push(k);
                }
            }
        } else {
            tries.extend(0..=n0);
        }
        for si in tries {
            if si == sheets.len() {
                if tog && opened.contains_key(&gid) {
                    fail.push(e.uid);
                    why.push("junto");
                    placed = true;
                    break;
                }
                sheets.push(Sheet::new(w, h));
            }
            if tog && opened.get(&gid).map_or(false, |&o| o != si) {
                continue;
            }
            if !allows(&sheets[si].gids, gid, rules) {
                if si == sheets.len() - 1 && sheets[si].placed.is_empty() {
                    sheets.pop();
                    fail.push(e.uid);
                    why.push("tamanho");
                    placed = true;
                    break;
                }
                continue;
            }
            cands.clear();
            let sh = &mut sheets[si];
            for &a in angs {
                for mi in [false, true] {
                    if mi && !it.mirror {
                        continue;
                    }
                    let key = (it.tid, a.to_bits(), mi);
                    let mid = match cache.map.get(&key) {
                        Some(&m) => m,
                        None => {
                            let (rings, mw, mh) = transform(&it.rings, a, mi);
                            cache.masks.push(build_mask(&rings, mw, mh, cs, r));
                            cache.big.push(if rb != r { Some(build_mask(&rings, mw, mh, cs, rb)) } else { None });
                            cache.map.insert(key, cache.masks.len() - 1);
                            cache.masks.len() - 1
                        }
                    };
                    let m = &cache.masks[mid];
                    if m.w + 2 * edge > w || m.h + 2 * edge > h {
                        continue;
                    }
                    if sh.memo.len() <= mid {
                        sh.memo.resize(mid + 1, Memo::Unknown);
                    }
                    let last = match sh.memo[mid] {
                        Memo::Never => continue,
                        Memo::At(x, y) => Some((x, y)),
                        Memo::Unknown => None,
                    };
                    if sh.used + m.cells > (w * h) as u64 {
                        sh.memo[mid] = Memo::Never;
                        continue;
                    }
                    let cap: i64 = if opt.boxed || cands.len() <= gene { w as i64 } else { cands[gene].key[0] as i64 - m.w as i64 + 1 };
                    let sp = match sh.find(m, cap, last, &mut forb, edge) {
                        Some(sp) => sp,
                        None => {
                            if cap >= w as i64 {
                                sh.memo[mid] = Memo::Never; // busca completa: não cabe mais nesta chapa
                            }
                            continue;
                        }
                    };
                    sh.memo[mid] = Memo::At(sp.0, sp.1);
                    let right = (sp.0 + m.w) as u64;
                    let key = if opt.boxed {
                        [(sh.extent as u64).max(right) * (sh.top.max(sp.1 + m.h) as u64), right, sp.1 as u64]
                    } else {
                        [right, sp.1 as u64, 0]
                    };
                    cands.push(Cand { key, a, mi, mask: mid, sp });
                    cands.sort_by(|p, q| p.key.cmp(&q.key));
                }
            }
            if !cands.is_empty() {
                let c = &cands[gene.min(cands.len() - 1)];
                let m = &cache.masks[c.mask];
                sh.put(m, cache.big[c.mask].as_ref().unwrap_or(m), rb - r, c.sp.0, c.sp.1);
                sh.gids.insert(gid);
                if tog && !opened.contains_key(&gid) {
                    opened.insert(gid, si);
                }
                if it.prod != 0 {
                    let s = span.entry(it.prod).or_insert((si, si));
                    *s = (s.0.min(si), s.1.max(si));
                }
                sh.placed.push(Placed {
                    uid: e.uid,
                    a: c.a,
                    mi: c.mi,
                    x: opt.mar + (c.sp.0 + r) as f64 * cs,
                    y: opt.mar + (c.sp.1 + r) as f64 * cs,
                });
                placed = true;
                break;
            }
            if si == sheets.len() - 1 && sheets[si].placed.is_empty() {
                sheets.pop();
                fail.push(e.uid);
                why.push("tamanho");
                placed = true;
                break;
            }
        }
        if !placed {
            fail.push(e.uid);
            why.push("tamanho");
        }
    }
    Res { sheets: sheets.into_iter().map(|s| SheetOut { placed: s.placed, extent: s.extent }).collect(), fail, why }
}

// ---------- melhor solução do grupo (compartilhada entre os núcleos) ----------

type BestKey = (usize, usize, i64);

struct Snapshot {
    sheets: Vec<Vec<Placed>>,
    fail: Vec<usize>,
    why: Vec<&'static str>,
    extent: Vec<i64>,
}

struct SharedState {
    best: Option<(BestKey, Snapshot)>,
    sent: Option<Instant>,
    pending: bool,
}

/// Todo núcleo oferece aqui cada solução melhor que acha. O resultado final do grupo é
/// o melhor de todos, e é daqui que sai a prévia mostrada na tela durante o cálculo.
struct Shared<'a> {
    key: &'a str,
    ids: &'a [String],
    mar: f64,
    t0: Instant,
    emit: bool,
    state: Mutex<SharedState>,
}

impl<'a> Shared<'a> {
    fn new(key: &'a str, ids: &'a [String], mar: f64, emit: bool) -> Shared<'a> {
        Shared { key, ids, mar, t0: Instant::now(), emit, state: Mutex::new(SharedState { best: None, sent: None, pending: false }) }
    }

    fn offer(&self, res: &Res, cs: f64) {
        let extent: Vec<i64> = res.sheets.iter().map(|s| (self.mar + s.extent as f64 * cs).round_ties_even() as i64).collect();
        let key: BestKey = (res.fail.len(), res.sheets.len(), extent.last().copied().unwrap_or(0));
        let mut st = self.state.lock().unwrap();
        if st.best.as_ref().map_or(true, |b| key < b.0) {
            let snap = Snapshot { sheets: res.sheets.iter().map(|s| s.placed.clone()).collect(), fail: res.fail.clone(), why: res.why.clone(), extent };
            st.best = Some((key, snap));
            st.pending = true;
            self.flush(&mut st);
        }
    }

    /// Manda a prévia pendente, no máximo uma a cada 300 ms.
    fn tick(&self) {
        if self.emit {
            let mut st = self.state.lock().unwrap();
            self.flush(&mut st);
        }
    }

    fn flush(&self, st: &mut SharedState) {
        if !self.emit || !st.pending || st.sent.map_or(false, |t| t.elapsed() < Duration::from_millis(300)) {
            return;
        }
        if let Some((_, snap)) = &st.best {
            let line = format!("{{\"progress\":{{\"key\":{},\"t\":{:.1},{}}}}}\n", json::quote(self.key), self.t0.elapsed().as_secs_f64(), snap_json(self.ids, snap));
            let mut so = std::io::stdout().lock();
            let _ = so.write_all(line.as_bytes());
            let _ = so.flush();
        }
        st.sent = Some(Instant::now());
        st.pending = false;
    }
}

fn snap_json(ids: &[String], b: &Snapshot) -> String {
    let sheets: Vec<String> = b.sheets.iter().map(|s| placed_json(ids, s)).collect();
    let fail: Vec<String> = b.fail.iter().map(|&u| ids[u].clone()).collect();
    let why: Vec<String> = b.why.iter().map(|w| json::quote(w)).collect();
    let ext: Vec<String> = b.extent.iter().map(|e| e.to_string()).collect();
    format!("\"sheets\":[{}],\"fail\":[{}],\"fail_why\":[{}],\"extent\":[{}]", sheets.join(","), fail.join(","), why.join(","), ext.join(","))
}

// ---------- busca ----------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03)
    }
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Best {
    order: Vec<Ent>,
    res: Res,
    sc: Score,
}

/// Busca local sobre ordem + gene de diversificação.
#[allow(clippy::too_many_arguments)]
fn search(items: &[Item], fine: &[Vec<f64>], g: (f64, f64), opt: &Opt, seconds: f64, rnd: &mut Rng, known: Option<Best>, cache: &mut Cache, shared: &Shared) -> (Best, u64) {
    let t0 = Instant::now();
    let over = |t: &Instant| stopped() || t.elapsed().as_secs_f64() > seconds;
    let mut best = known;
    if best.is_none() {
        let boxes: Vec<(f64, f64)> = items
            .iter()
            .map(|i| {
                let mut b = (f64::NEG_INFINITY, f64::NEG_INFINITY);
                for r in &i.rings {
                    for p in r {
                        b = (b.0.max(p.0), b.1.max(p.1));
                    }
                }
                b
            })
            .collect();
        let keys: [Box<dyn Fn(usize) -> f64>; 3] = [
            Box::new(|i| -items[i].area),
            Box::new(|i| -boxes[i].0.max(boxes[i].1)),
            Box::new(|i| -(boxes[i].0 * boxes[i].1)),
        ];
        for key in keys.iter() {
            let mut idx: Vec<usize> = (0..items.len()).collect();
            idx.sort_by(|&a, &b| key(a).partial_cmp(&key(b)).unwrap());
            let o: Vec<Ent> = idx.into_iter().map(|uid| Ent { uid, gene: 0, fine: false }).collect();
            let res = pack(&o, items, fine, g, opt, cache);
            let sc = score(&res);
            if best.as_ref().map_or(true, |b| sc < b.sc) {
                shared.offer(&res, opt.cs);
                best = Some(Best { order: o, res, sc });
            }
            if over(&t0) {
                break;
            }
        }
    }
    let mut best = best.expect("ao menos uma ordem inicial");
    let mut iters = 0u64;
    let n = best.order.len();
    while !over(&t0) && n > 1 {
        let mut o = best.order.clone();
        let moves = [1, 1, 2, 3][rnd.below(4)];
        for _ in 0..moves {
            let (i, j) = (rnd.below(n), rnd.below(n));
            let t = rnd.unit();
            if t < 0.4 {
                o.swap(i, j);
            } else if t < 0.8 {
                let x = o.remove(i);
                o.insert(j.min(o.len()), x);
            } else {
                o[i].gene = 1 - o[i].gene;
            }
        }
        let res = pack(&o, items, fine, g, opt, cache);
        let sc = score(&res);
        iters += 1;
        if sc <= best.sc {
            if sc < best.sc {
                shared.offer(&res, opt.cs);
            }
            best = Best { order: o, res, sc };
        }
        shared.tick();
    }
    (best, iters)
}

struct Base<'a> {
    gap: f64,
    mar: f64,
    cs: f64,
    rules: &'a Rules,
    seq: bool,
    near: bool,
}

/// Etapa 1 (grossa): grade de 4 mm, muitos ângulos, acha ordem e giro.
/// Etapa 2 (fina): grade pedida, ângulos refinados ao redor dos escolhidos.
fn nest_group(g: (f64, f64), items: &[Item], base: &Base, seconds: f64, seed: u64, boxed: bool, shared: &Shared) -> u64 {
    let mut rnd = Rng::new(seed);
    let t0 = Instant::now();
    let (gap, mar, cs) = (base.gap, base.mar, base.cs);
    let free_any = items.iter().any(|i| i.angs.len() > 4);
    let t1 = seconds * if free_any { 0.55 } else { 0.4 };
    let cs1 = if free_any { cs.max(4.0) } else { cs };
    let none: Vec<Vec<f64>> = vec![Vec::new(); items.len()];
    let (r1, rb1) = radii(gap, cs1);
    let o1 = Opt { cs: cs1, mar, r: r1, rb: rb1, boxed, rules: base.rules, seq: base.seq, near: base.near };
    let (b1, it1) = search(items, &none, g, &o1, t1, &mut rnd, None, &mut Cache::default(), shared);
    // etapa 2: refina ângulos ao redor do escolhido por peça
    let mut chosen: Vec<Option<f64>> = vec![None; items.len()];
    for sh in &b1.res.sheets {
        for p in &sh.placed {
            chosen[p.uid] = Some(p.a);
        }
    }
    let fine: Vec<Vec<f64>> = items
        .iter()
        .enumerate()
        .map(|(uid, it)| match chosen[uid] {
            Some(a) if free_any && it.angs.len() > 4 => {
                let mut v = refine(a);
                if it.angs.contains(&0.0) {
                    v.extend([0.0, 180.0]);
                }
                sorted_set(v)
            }
            _ => it.angs.clone(),
        })
        .collect();
    let order: Vec<Ent> = b1.order.iter().map(|e| Ent { uid: e.uid, gene: e.gene, fine: true }).collect();
    let (r2, rb2) = radii(gap, cs);
    let o2 = Opt { cs, mar, r: r2, rb: rb2, boxed, rules: base.rules, seq: base.seq, near: base.near };
    let mut cache2 = Cache::default();
    let tp0 = Instant::now();
    let r1 = pack(&order, items, &fine, g, &o2, &mut cache2);
    let tp = tp0.elapsed().as_secs_f64(); // custo de uma tentativa na grade fina
    shared.offer(&r1, cs);
    let mut best = Best { sc: score(&r1), order, res: r1 };
    // O prazo vale: só gasta outra tentativa na grade fina se ainda couber no tempo pedido.
    if !stopped() && t0.elapsed().as_secs_f64() + tp < seconds {
        let mut idx: Vec<usize> = (0..items.len()).collect();
        idx.sort_by(|&a, &b| (-items[a].area).partial_cmp(&-items[b].area).unwrap());
        let plain: Vec<Ent> = idx.into_iter().map(|uid| Ent { uid, gene: 0, fine: false }).collect();
        let r2 = pack(&plain, items, &fine, g, &o2, &mut cache2);
        shared.offer(&r2, cs);
        if score(&r2) < best.sc {
            best = Best { sc: score(&r2), order: plain, res: r2 };
        }
    }
    let mut it2 = 0;
    let left = seconds - t0.elapsed().as_secs_f64();
    if !stopped() && left > tp {
        let (_, n) = search(items, &fine, g, &o2, left - tp, &mut rnd, Some(best), &mut cache2, shared);
        it2 = n;
    }
    it1 + it2
}

// ---------- entrada e saída ----------

fn ring_of(j: &J) -> Ring {
    j.arr().iter().map(|p| (p.arr().first().and_then(J::num).unwrap_or(0.0), p.arr().get(1).and_then(J::num).unwrap_or(0.0))).collect()
}

struct Group {
    key: String,
    w: f64,
    h: f64,
    items: Vec<Item>,
    ids: Vec<String>,
}

struct Names(Vec<String>);

impl Names {
    fn id(&mut self, s: &str) -> usize {
        match self.0.iter().position(|x| x == s) {
            Some(i) => i,
            None => {
                self.0.push(s.to_string());
                self.0.len() - 1
            }
        }
    }
}

fn read_group(key: &str, v: &J, rot: i64, gids: &mut Names, gap: f64, mar: f64) -> Group {
    let mut tids: HashMap<String, usize> = HashMap::new();
    let mut prods: HashMap<String, usize> = HashMap::new();
    let mut angs: HashMap<(usize, String), Vec<f64>> = HashMap::new();
    let mut items = Vec::new();
    let mut ids = Vec::new();
    for it in v.get("items").map_or(&[][..], J::arr) {
        let id = it.get("id").map_or("null".to_string(), J::raw);
        let next = tids.len();
        let tid = *tids.entry(id.clone()).or_insert(next);
        let rings: Vec<Ring> = it.get("rings").map_or(&[][..], J::arr).iter().map(ring_of).collect();
        let mode = it.get("rot").map_or("auto".to_string(), J::text);
        let a = angs.entry((tid, mode.clone())).or_insert_with(|| angle_set(&rings, rot, &mode)).clone();
        let gid = it.get("gid").filter(|g| g.truthy()).map_or(String::new(), J::text);
        items.push(Item {
            tid,
            rings,
            area: it.get("area").and_then(J::num).unwrap_or(0.0),
            mirror: it.get("mirror").map_or(false, J::truthy),
            gid: gids.id(&gid),
            angs: a,
            gap: it.get("gap").and_then(J::num).filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(gap),
            mar: it.get("mar").and_then(J::num).filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(mar),
            prod: match it.get("prod").map(J::text).filter(|t| !t.is_empty()) {
                Some(t) => {
                    let n = prods.len() + 1;
                    *prods.entry(t).or_insert(n)
                }
                None => 0,
            },
            rank: it.get("rank").and_then(J::num).unwrap_or(0.0) as i64,
        });
        ids.push(id);
    }
    Group { key: key.to_string(), w: v.get("w").and_then(J::num).unwrap_or(0.0), h: v.get("h").and_then(J::num).unwrap_or(0.0), items, ids }
}

fn id_list(v: Option<&J>, gids: &mut Names) -> HashSet<usize> {
    let mut out = HashSet::new();
    for x in v.map_or(&[][..], J::arr) {
        let t = x.text();
        let t = t.trim();
        if !t.is_empty() {
            out.insert(gids.id(t));
        }
    }
    out
}

fn read_rules(p: &J, gids: &mut Names) -> Rules {
    let raw = p.get("rules");
    let get = |k: &str| raw.and_then(|r| r.get(k));
    let mut forbid: Vec<(usize, usize)> = Vec::new();
    for pair in get("forbid").map_or(&[][..], J::arr) {
        let pr = pair.arr();
        if pr.len() < 2 {
            continue;
        }
        let (a, b) = (pr[0].text(), pr[1].text());
        let (a, b) = (a.trim(), b.trim());
        if a.is_empty() || b.is_empty() || a == b {
            continue;
        }
        let (a, b) = (gids.id(a), gids.id(b));
        if !forbid.contains(&(a, b)) && !forbid.contains(&(b, a)) {
            forbid.push((a, b));
        }
    }
    Rules { mix: get("mix").map_or(true, J::truthy), isolate: id_list(get("isolate"), gids), together: id_list(get("together"), gids), forbid }
}

fn fnum(v: f64) -> String {
    if v.is_finite() {
        format!("{}", v)
    } else {
        "0".to_string()
    }
}

fn placed_json(ids: &[String], sh: &[Placed]) -> String {
    let parts: Vec<String> = sh
        .iter()
        .map(|p| format!("{{\"id\":{},\"a\":{},\"mi\":{},\"x\":{},\"y\":{}}}", ids[p.uid], fnum(p.a), p.mi as u8, fnum(p.x), fnum(p.y)))
        .collect();
    format!("[{}]", parts.join(","))
}

fn run(text: &str) -> Result<String, String> {
    let p = json::parse(text)?;
    let num = |k: &str, d: f64| p.get(k).and_then(J::num).unwrap_or(d);
    let (gap, mar, cs) = (num("gap", 4.0), num("mar", 5.0), num("cs", 2.0));
    let rot = num("rot", 90.0) as i64;
    let (seq, near) = (p.get("seq").map_or(false, J::truthy), p.get("near").map_or(false, J::truthy));
    let total = num("seconds", 20.0);
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let want = num("workers", 0.0) as usize;
    let workers = if want > 0 { want.min(cores).max(1) } else { cores };
    if !(cs > 0.0) {
        return Err("grade inválida".to_string());
    }
    let mut gids = Names(vec![String::new()]);
    let rules = read_rules(&p, &mut gids);
    let groups: Vec<Group> = p.get("groups").map_or(&[][..], J::entries).iter().map(|(k, v)| read_group(k, v, rot, &mut gids, gap, mar)).collect();
    // grade e folga base de cada grupo: os menores valores entre o encaixe e as peças com valor próprio
    let low = |g: &Group| (g.items.iter().map(|i| i.gap).fold(gap, f64::min), g.items.iter().map(|i| i.mar).fold(mar, f64::min));

    // modo de conferência: encaixa uma ordem dada, sem busca (compara com o nest.py)
    if let Some(order) = p.get("order") {
        let g = groups.first().ok_or("sem grupo")?;
        let (gap, mar) = low(g);
        let ord: Vec<Ent> = order.arr().iter().map(|e| Ent { uid: e.arr()[0].num().unwrap_or(0.0) as usize, gene: e.arr()[1].num().unwrap_or(0.0) as u8, fine: false }).collect();
        let (r, rb) = radii(gap, cs);
        let opt = Opt { cs, mar, r, rb, boxed: p.get("crit").map_or(false, |c| c.text() == "box"), rules: &rules, seq, near };
        let res = pack(&ord, &g.items, &vec![Vec::new(); g.items.len()], (g.w, g.h), &opt, &mut Cache::default());
        let sheets: Vec<String> = res
            .sheets
            .iter()
            .map(|s| format!("[{}]", s.placed.iter().map(|q| format!("[{},{},{},{},{}]", q.uid, fnum(q.a), q.mi as u8, fnum(q.x), fnum(q.y))).collect::<Vec<_>>().join(",")))
            .collect();
        let fail: Vec<String> = res.fail.iter().map(|u| u.to_string()).collect();
        return Ok(format!("{{\"sheets\":[{}],\"fail\":[{}]}}", sheets.join(","), fail.join(",")));
    }

    let emit = p.get("progress").map_or(false, J::truthy);
    // Parada pedida pelo servidor: ele cria este arquivo e o motor fecha com o melhor até ali.
    if let Some(J::Str(path)) = p.get("stop_file") {
        let path = path.clone();
        std::thread::spawn(move || loop {
            if std::path::Path::new(&path).exists() {
                STOP.store(true, Ordering::Relaxed);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        });
    }
    let weight: Vec<f64> = groups.iter().map(|g| g.items.iter().map(|i| i.area).sum::<f64>().max(1.0)).collect();
    let wsum: f64 = weight.iter().sum();
    let mut out: Vec<String> = Vec::new();
    for (g, wgt) in groups.iter().zip(&weight) {
        // depois de uma parada, os grupos que faltam recebem só o mínimo: uma passada
        let secs = if stopped() { 0.0 } else { (total * wgt / wsum).max(1.0) };
        let dims = (g.w, g.h);
        let (gap, mar) = low(g);
        let base = Base { gap, mar, cs, rules: &rules, seq, near };
        let shared = Shared::new(&g.key, &g.ids, mar, emit);
        // metade dos núcleos com cada critério de posição; fica a melhor solução de todos
        let iters: u64 = if workers < 2 {
            nest_group(dims, &g.items, &base, secs / 2.0, 1, false, &shared) + nest_group(dims, &g.items, &base, secs / 2.0, 1, true, &shared)
        } else {
            std::thread::scope(|s| {
                let hs: Vec<_> = (0..workers)
                    .map(|n| {
                        let (items, base, shared) = (&g.items, &base, &shared);
                        s.spawn(move || nest_group(dims, items, base, secs, 1 + 97 * n as u64, n % 2 == 1, shared))
                    })
                    .collect();
                hs.into_iter().map(|h| h.join().expect("falha em um núcleo do encaixe")).sum()
            })
        };
        let st = shared.state.lock().unwrap();
        let (_, b) = st.best.as_ref().ok_or("grupo sem solução")?;
        out.push(format!(
            "{}:{{{},\"iters\":{},\"workers\":{},\"engine\":\"rust\",\"stopped\":{}}}",
            json::quote(&g.key),
            snap_json(&g.ids, b),
            iters,
            if workers < 2 { 1 } else { workers },
            stopped()
        ));
    }
    Ok(format!("{{{}}}", out.join(",")))
}

fn main() {
    let mut text = String::new();
    if std::io::stdin().read_to_string(&mut text).is_err() {
        eprintln!("entrada inválida (não é UTF-8)");
        std::process::exit(2);
    }
    match run(&text) {
        Ok(o) => {
            let mut so = std::io::stdout().lock();
            let _ = so.write_all(o.as_bytes());
            let _ = so.write_all(b"\n");
            let _ = so.flush();
        }
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1);
        }
    }
}
