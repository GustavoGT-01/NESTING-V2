/* Simulação de usinagem (2D e 3D), no estilo da simulação do Alphacam.
   Lê o G-code gerado, remove material de uma chapa virtual (mapa de alturas) e mostra o resultado
   de cima (2D, canvas) ou em perspectiva (3D, WebGL2, sem bibliotecas). Avisa movimentos rápidos
   dentro do material (colisão). Expõe window.CamSim.open(opts). */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const MATS = {
    mdf: { name: 'MDF cru', top: '#c49a6c', core: '#a97c50' },
    bp: { name: 'MDF BP branco', top: '#efede6', core: '#a97c50' },
    bpp: { name: 'MDF BP preto', top: '#2c2c2e', core: '#a97c50' },
    comp: { name: 'Compensado', top: '#dcb886', core: '#c99c62' },
    acr: { name: 'Acrílico', top: '#a8dcf0', core: '#7fc2de' },
    acm: { name: 'ACM (alumínio composto)', top: '#d4d8dc', core: '#3b3d40' },
    custom: { name: 'Personalizado' },
  };
  const SPOIL = '#6f6455';
  const hex = c => { const n = parseInt(String(c).slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

  /* ---------------- G-code -> movimentos ---------------- */
  function parse(files, tools, o) {
    const moves = [], byNum = new Map(tools.map(t => [+t.num, t]));
    let pos = null, mode = 0, feed = 1000, tool = null, pend = null, t = 0;
    const toH = z => (o.zero === 'mesa' ? z : z + o.th);
    files.forEach((f, fi) => {
      if (f.num != null && byNum.has(+f.num)) tool = byNum.get(+f.num);
      const lines = f.gcode.split(/\r?\n/);
      lines.forEach((raw, li) => {
        const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
        if (!line) return;
        const w = {}; const gs = [];
        line.replace(/([A-Z])\s*(-?\d*\.?\d+)/g, (_, k, v) => { if (k === 'G') gs.push(+v); else w[k] = +v; return ''; });
        for (const g of gs) if (g === 0 || g === 1) mode = g;
        if (w.T != null) pend = +w.T;
        if (w.M === 6 && pend != null) { tool = byNum.get(pend) || tool; pend = null; }
        if (w.F != null) feed = w.F;
        if (w.X == null && w.Y == null && w.Z == null) return;
        const p = { x: w.X ?? (pos ? pos.x : 0), y: w.Y ?? (pos ? pos.y : 0), h: w.Z != null ? toH(w.Z) : (pos ? pos.h : o.th + 50) };
        if (!pos) { pos = p; return; }
        const d = Math.hypot(p.x - pos.x, p.y - pos.y, p.h - pos.h);
        const sp = mode === 0 ? o.rapid : Math.max(1, feed);
        const dt = d / sp * 60;
        moves.push({ x0: pos.x, y0: pos.y, h0: pos.h, x1: p.x, y1: p.y, h1: p.h, rapid: mode === 0, tool, t0: t, t1: t + dt, file: fi, line: li + 1, src: raw.trim() });
        t += dt; pos = p;
      });
    });
    // área cortada: o enquadramento mostra o trabalho, não a chapa inteira
    const box = [1e18, 1e18, -1e18, -1e18];
    for (const mv of moves) if (!mv.rapid) for (const [x, y] of [[mv.x0, mv.y0], [mv.x1, mv.y1]]) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
    if (box[0] > box[2]) box.splice(0, 4, 0, 0, o.sheetW || 1, o.sheetH || 1);
    const pad = Math.max(30, Math.max(box[2] - box[0], box[3] - box[1]) * 0.08);
    return { moves, total: t, box: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] };
  }

  /* ---------------- chapa virtual (mapa de alturas) ---------------- */
  class Stock {
    constructor(W, H, th, over) {
      this.W = W; this.H = H; this.th = th; this.over = over;
      this.m = Math.max(10, Math.max(W, H) * 0.02);                // mesa visível em volta da chapa
      const tw = W + 2 * this.m, tl = H + 2 * this.m;
      this.cell = Math.max(0.5, Math.max(tw, tl) / 2048);
      this.nx = Math.ceil(tw / this.cell); this.ny = Math.ceil(tl / this.cell);
      this.h = new Float32Array(this.nx * this.ny);
      this.reset();
    }
    reset() {
      const { nx, ny, cell, m, W, H, th } = this;
      for (let j = 0; j < ny; j++) {
        const y = j * cell - m, inY = y >= 0 && y <= H;
        for (let i = 0; i < nx; i++) { const x = i * cell - m; this.h[j * nx + i] = inY && x >= 0 && x <= W ? th : 0; }
      }
      this.dirty = [0, 0, nx - 1, ny - 1];
    }
    at(x, y) {
      const i = Math.round((x + this.m) / this.cell), j = Math.round((y + this.m) / this.cell);
      return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? 0 : this.h[j * this.nx + i];
    }
    mark(i0, j0, i1, j1) {
      const d = this.dirty;
      if (!d) this.dirty = [i0, j0, i1, j1];
      else { d[0] = Math.min(d[0], i0); d[1] = Math.min(d[1], j0); d[2] = Math.max(d[2], i1); d[3] = Math.max(d[3], j1); }
    }
    disc(x, y, h, r) {   // fresa de topo reto: tudo dentro do raio fica no máximo na altura da ponta
      const { nx, ny, cell, m } = this, ci = (x + m) / cell, cj = (y + m) / cell, rc = r / cell;
      const i0 = Math.max(0, Math.floor(ci - rc - 1)), i1 = Math.min(nx - 1, Math.ceil(ci + rc + 1));
      const j0 = Math.max(0, Math.floor(cj - rc - 1)), j1 = Math.min(ny - 1, Math.ceil(cj + rc + 1));
      const r2 = (rc + 0.5) * (rc + 0.5); let hit = false;
      for (let j = j0; j <= j1; j++) {
        const dy = j - cj, row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const dx = i - ci, d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          // célula na borda da fresa: corte proporcional à parte coberta (parede lisa, sem escadinha)
          const c = Math.min(1, rc + 0.5 - Math.sqrt(d2)), old = this.h[row + i], v = old - (old - h) * c;
          if (v < old) { this.h[row + i] = v; hit = true; }
        }
      }
      if (hit) this.mark(i0, j0, i1, j1);
    }
    seg(x0, y0, h0, x1, y1, h1, r) {
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / (this.cell * 0.5)));
      for (let k = 0; k <= n; k++) { const t = k / n; this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, h0 + (h1 - h0) * t, r); }
    }
    takeDirty() { const d = this.dirty; this.dirty = null; return d; }
  }

  /* ---------------- motor da simulação ---------------- */
  class Sim {
    constructor(plan, stock) { this.p = plan; this.s = stock; this.restart(); }
    restart() { this.s.reset(); this.i = 0; this.done = 0; this.t = 0; this.hits = []; }
    point(mv, f) { return [mv.x0 + (mv.x1 - mv.x0) * f, mv.y0 + (mv.y1 - mv.y0) * f, mv.h0 + (mv.h1 - mv.h0) * f]; }
    apply(mv, f0, f1) {
      if (f1 <= f0) return;
      const a = this.point(mv, f0), b = this.point(mv, f1);
      if (mv.rapid) {   // rápido dentro do material = colisão na máquina
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / this.s.cell));
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, h = a[2] + (b[2] - a[2]) * t;
          if (h < this.s.at(x, y) - 0.05) { if (!this.hits.some(q => q.line === mv.line && q.file === mv.file)) this.hits.push(mv); break; }
        }
        return;
      }
      const r = mv.tool ? mv.tool.dia / 2 : 3;
      this.s.seg(a[0], a[1], a[2], b[0], b[1], b[2], r);
    }
    seek(t) {
      if (t < this.t) this.restart();
      const M = this.p.moves;
      while (this.i < M.length) {
        const mv = M[this.i], span = mv.t1 - mv.t0;
        const f = span <= 0 ? 1 : Math.min(1, (t - mv.t0) / span);
        if (f <= 0) break;
        this.apply(mv, this.done, f);
        if (f < 1) { this.done = f; break; }
        this.i++; this.done = 0;
      }
      this.t = Math.min(t, this.p.total);
    }
    current() { const M = this.p.moves; return M[Math.min(this.i, M.length - 1)]; }
    toolPos() {
      const mv = this.current();
      if (!mv) return null;
      return this.point(mv, this.i >= this.p.moves.length ? 1 : this.done);
    }
  }

  /* ---------------- 2D ---------------- */
  class View2D {
    constructor(canvas, stock, plan, colors) {
      this.c = canvas; this.g = canvas.getContext('2d'); this.s = stock; this.p = plan;
      this.off = document.createElement('canvas'); this.off.width = stock.nx; this.off.height = stock.ny;
      this.og = this.off.getContext('2d'); this.img = this.og.createImageData(stock.nx, stock.ny);
      this.setColors(colors); this.fit();
      this.path = new Path2D(); this.rap = new Path2D();
      for (const mv of plan.moves) { const P = mv.rapid ? this.rap : this.path; P.moveTo(mv.x0, mv.y0); P.lineTo(mv.x1, mv.y1); }
    }
    setColors(c) {
      const top = hex(c.top), core = hex(c.core), sp = hex(SPOIL), th = this.s.th;
      this.color = h => { let k; if (h >= th - 0.05) k = top; else if (h <= 0.05) k = sp; else { const f = 0.6 + 0.4 * h / th; k = core.map(v => v * f); } return k; };
      this.s.dirty = [0, 0, this.s.nx - 1, this.s.ny - 1];
    }
    fit() { const [x0, y0, x1, y1] = this.p.box, w = x1 - x0, h = y1 - y0; this.z = Math.min(this.c.width / w, this.c.height / h); this.ox = (this.c.width - w * this.z) / 2 - x0 * this.z; this.oy = (this.c.height - h * this.z) / 2 - y0 * this.z; }
    upload() {
      const d = this.s.takeDirty(); if (!d) return;
      const { nx, ny } = this.s, D = this.img.data;
      for (let j = d[1]; j <= d[3]; j++) for (let i = d[0]; i <= d[2]; i++) {
        const k = this.color(this.s.h[j * nx + i]), q = ((ny - 1 - j) * nx + i) * 4;
        D[q] = k[0] * 255; D[q + 1] = k[1] * 255; D[q + 2] = k[2] * 255; D[q + 3] = 255;
      }
      this.og.putImageData(this.img, 0, 0, d[0], ny - 1 - d[3], d[2] - d[0] + 1, d[3] - d[1] + 1);
    }
    draw(tool, showPath) {
      this.upload();
      const g = this.g, s = this.s, z = this.z;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0b0f14'; g.fillRect(0, 0, this.c.width, this.c.height);
      g.imageSmoothingEnabled = true;   // de perto também: borda do corte sem escadinha
      g.drawImage(this.off, this.ox - s.m * z, this.c.height - this.oy - (s.H + s.m) * z, (s.W + 2 * s.m) * z, (s.H + 2 * s.m) * z);
      g.setTransform(z, 0, 0, -z, this.ox, this.c.height - this.oy);
      if (showPath) {
        g.lineWidth = 1 / z; g.strokeStyle = 'rgba(56,189,248,.55)'; g.stroke(this.path);
        g.setLineDash([4 / z, 4 / z]); g.strokeStyle = 'rgba(241,245,249,.25)'; g.stroke(this.rap); g.setLineDash([]);
      }
      if (tool) {
        const [x, y, h, r] = tool;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = h < s.th ? 'rgba(248,113,113,.45)' : 'rgba(241,245,249,.35)'; g.fill();
        g.lineWidth = 1.5 / z; g.strokeStyle = '#f1f5f9'; g.stroke();
      }
    }
    zoomAt(px, py, k) { const z2 = Math.max(0.02, Math.min(200, this.z * k)); const yb = this.c.height - py; this.ox = px - (px - this.ox) * z2 / this.z; this.oy = yb - (yb - this.oy) * z2 / this.z; this.z = z2; }
    pan(dx, dy) { this.ox += dx; this.oy -= dy; }
  }

  /* ---------------- 3D (WebGL2) ---------------- */
  const M4 = {
    mul(a, b) { const o = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; },
    persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]); },
    look(e, c, u) {
      const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = norm(cross(u, z)), y = cross(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]);
    },
  };
  function norm(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // um vértice por célula do mapa (índice = j * largura + i): a parede do corte fica com a resolução da simulação
  const VS_T = `#version 300 es
uniform sampler2D hm;uniform vec2 org,dim;uniform mat4 mvp;out vec2 vUv;
void main(){ivec2 sz=textureSize(hm,0);int i=gl_VertexID%sz.x,j=gl_VertexID/sz.x;vec2 uv=(vec2(i,j)+.5)/vec2(sz);
float h=texelFetch(hm,ivec2(i,j),0).r;vUv=uv;gl_Position=mvp*vec4(org+uv*dim,h,1.);}`;
  const FS_T = `#version 300 es
precision highp float;in vec2 vUv;uniform sampler2D hm;uniform vec2 tx,cm;uniform vec3 cTop,cCore,cSp,L;uniform float th;out vec4 o;
float H(vec2 d){return texture(hm,vUv+d*tx).r;}
void main(){float h=H(vec2(0.));
// Sobel 3x3: normal suave, sem degrau de célula na luz
float gx=(H(vec2(1,-1))+2.*H(vec2(1,0))+H(vec2(1,1)))-(H(vec2(-1,-1))+2.*H(vec2(-1,0))+H(vec2(-1,1)));
float gy=(H(vec2(-1,1))+2.*H(vec2(0,1))+H(vec2(1,1)))-(H(vec2(-1,-1))+2.*H(vec2(0,-1))+H(vec2(1,-1)));
vec3 n=normalize(vec3(-gx/(8.*cm.x),-gy/(8.*cm.y),1.));
vec3 b=h>=th-.05?cTop:(h<=.05?cSp:cCore*(.6+.4*h/th));
float d=max(dot(n,normalize(L)),0.);o=vec4(b*(.38+.72*d),1.);}`;
  const VS_S = `#version 300 es
in vec3 p;in vec3 n;in vec3 c;uniform mat4 mvp,mdl;out vec3 vN;out vec3 vC;
void main(){vN=mat3(mdl)*n;vC=c;gl_Position=mvp*mdl*vec4(p,1.);}`;
  const FS_S = `#version 300 es
precision highp float;in vec3 vN;in vec3 vC;uniform vec3 L;uniform float lit;out vec4 o;
void main(){float d=lit>.5?max(dot(normalize(vN),normalize(L)),0.):1.;o=vec4(vC*(lit>.5?.35+.75*d:1.),1.);}`;

  class View3D {
    constructor(canvas, stock, plan, colors) {
      const gl = canvas.getContext('webgl2', { antialias: true });
      if (!gl) throw Error('Este computador não tem WebGL2: use a simulação 2D.');
      this.gl = gl; this.c = canvas; this.s = stock; this.p = plan;
      this.pt = this.prog(VS_T, FS_T); this.ps = this.prog(VS_S, FS_S);
      const s = stock;
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, s.nx, s.ny, 0, gl.RED, gl.FLOAT, s.h);
      // interpolação das alturas quando a placa de vídeo permite (quase todas): luz e cor sem degraus
      const lin = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, lin], [gl.TEXTURE_MAG_FILTER, lin], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      // malha na resolução cheia, em faixas (TRIANGLE_STRIP + reinício 0xFFFFFFFF): só índices, a posição sai do índice
      const gx = s.nx, gy = s.ny, idx = new Uint32Array((gy - 1) * (gx * 2 + 1)); let k = 0;
      for (let j = 0; j < gy - 1; j++) { for (let i = 0; i < gx; i++) { idx[k++] = j * gx + i; idx[k++] = (j + 1) * gx + i; } idx[k++] = 0xFFFFFFFF; }
      this.tVao = gl.createVertexArray(); gl.bindVertexArray(this.tVao);
      this.tIb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.tIb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); this.tN = idx.length;
      this.tool = this.cylinder(); this.lines = this.pathLines();
      this.setColors(colors);
      this.cam = {}; this.fit();
    }
    prog(vs, fs) {
      const gl = this.gl, p = gl.createProgram();
      for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); }
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
      p.u = n => gl.getUniformLocation(p, n); return p;
    }
    buf(p, name, data, size) { const gl = this.gl, b = gl.createBuffer(), loc = gl.getAttribLocation(p, name); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); } return b; }
    mesh(pos, nor, col, mode) { const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao); this.buf(this.ps, 'p', new Float32Array(pos), 3); this.buf(this.ps, 'n', new Float32Array(nor), 3); this.buf(this.ps, 'c', new Float32Array(col), 3); return { vao, n: pos.length / 3, mode }; }
    cylinder() {   // fresa (prata) + haste e porca (cinza), raio 1 e altura em mm reais escaladas depois
      const P = [], N = [], C = [], seg = 28;
      const ring = (r, z0, z1, col) => { for (let i = 0; i < seg; i++) { const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2; const q = [[Math.cos(a0), Math.sin(a0)], [Math.cos(a1), Math.sin(a1)]];
        const v = [[q[0][0] * r, q[0][1] * r, z0], [q[1][0] * r, q[1][1] * r, z0], [q[1][0] * r, q[1][1] * r, z1], [q[0][0] * r, q[0][1] * r, z0], [q[1][0] * r, q[1][1] * r, z1], [q[0][0] * r, q[0][1] * r, z1]];
        const nn = [q[0], q[1], q[1], q[0], q[1], q[0]];
        v.forEach((p, k) => { P.push(...p); N.push(nn[k][0], nn[k][1], 0); C.push(...col); });
        P.push(0, 0, z0, q[1][0] * r, q[1][1] * r, z0, q[0][0] * r, q[0][1] * r, z0); N.push(0, 0, -1, 0, 0, -1, 0, 0, -1); C.push(...col, ...col, ...col);
        P.push(0, 0, z1, q[0][0] * r, q[0][1] * r, z1, q[1][0] * r, q[1][1] * r, z1); N.push(0, 0, 1, 0, 0, 1, 0, 0, 1); C.push(...col, ...col, ...col); } };
      ring(1, 0, 22, [0.82, 0.85, 0.9]); ring(1, 22, 45, [0.55, 0.58, 0.62]); ring(2.4, 45, 62, [0.3, 0.32, 0.36]);
      return this.mesh(P, N, C, this.gl.TRIANGLES);
    }
    pathLines() {
      const P = [], N = [], C = [];
      for (const mv of this.p.moves) { const c = mv.rapid ? [0.55, 0.6, 0.68] : [0.22, 0.74, 0.97]; P.push(mv.x0, mv.y0, mv.h0 + 0.05, mv.x1, mv.y1, mv.h1 + 0.05); N.push(0, 0, 1, 0, 0, 1); C.push(...c, ...c); }
      return this.mesh(P, N, C, this.gl.LINES);
    }
    setColors(c) { this.col = { top: hex(c.top), core: hex(c.core), sp: hex(SPOIL) }; }
    upload() {
      const d = this.s.takeDirty(); if (!d) return;
      const gl = this.gl, s = this.s; gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, d[1], s.nx, d[3] - d[1] + 1, gl.RED, gl.FLOAT, s.h, d[1] * s.nx);
    }
    matrices() {
      const c = this.cam, e = [c.tx + c.dist * Math.cos(c.el) * Math.cos(c.az), c.ty + c.dist * Math.cos(c.el) * Math.sin(c.az), c.tz + c.dist * Math.sin(c.el)];
      const asp = this.c.width / this.c.height, span = Math.max(this.s.W, this.s.H);
      return M4.mul(M4.persp(0.8, asp, Math.max(1, c.dist / 200), c.dist + span * 4), M4.look(e, [c.tx, c.ty, c.tz], [0, 0, 1]));
    }
    draw(tool, showPath) {
      const gl = this.gl, s = this.s; this.upload();
      gl.viewport(0, 0, this.c.width, this.c.height); gl.clearColor(0.043, 0.059, 0.078, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
      const mvp = this.matrices(), L = [0.35, -0.5, 0.8];
      gl.useProgram(this.pt); gl.bindVertexArray(this.tVao); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      const u = this.pt.u; gl.uniform1i(u('hm'), 0); gl.uniformMatrix4fv(u('mvp'), false, mvp);
      gl.uniform2f(u('org'), -s.m, -s.m); gl.uniform2f(u('dim'), s.nx * s.cell, s.ny * s.cell); gl.uniform2f(u('tx'), 1 / s.nx, 1 / s.ny); gl.uniform2f(u('cm'), s.cell, s.cell);
      gl.uniform3fv(u('cTop'), this.col.top); gl.uniform3fv(u('cCore'), this.col.core); gl.uniform3fv(u('cSp'), this.col.sp); gl.uniform3fv(u('L'), L); gl.uniform1f(u('th'), s.th);
      gl.drawElements(gl.TRIANGLE_STRIP, this.tN, gl.UNSIGNED_INT, 0);
      gl.useProgram(this.ps); const v = this.ps.u; gl.uniformMatrix4fv(v('mvp'), false, mvp); gl.uniform3fv(v('L'), L);
      if (showPath) { gl.uniform1f(v('lit'), 0); gl.uniformMatrix4fv(v('mdl'), false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])); gl.bindVertexArray(this.lines.vao); gl.drawArrays(gl.LINES, 0, this.lines.n); }
      if (tool) { const [x, y, h, r] = tool; gl.uniform1f(v('lit'), 1); gl.uniformMatrix4fv(v('mdl'), false, new Float32Array([r, 0, 0, 0, 0, r, 0, 0, 0, 0, 1, 0, x, y, h, 1])); gl.bindVertexArray(this.tool.vao); gl.drawArrays(gl.TRIANGLES, 0, this.tool.n); }
    }
    orbit(dx, dy) { const c = this.cam; c.az -= dx * 0.008; c.el = Math.max(0.08, Math.min(1.55, c.el + dy * 0.008)); }
    pan(dx, dy) { const c = this.cam, k = c.dist / this.c.height * 1.1, ca = Math.cos(c.az), sa = Math.sin(c.az); c.tx += (dx * sa + dy * ca * Math.sin(c.el)) * k; c.ty += (-dx * ca + dy * sa * Math.sin(c.el)) * k; }
    zoomAt(px, py, k) { this.cam.dist = Math.max(20, Math.min(Math.max(this.s.W, this.s.H) * 6, this.cam.dist / k)); }
    fit() { const [x0, y0, x1, y1] = this.p.box; Object.assign(this.cam, { az: -1.2, el: 0.8, dist: Math.max(x1 - x0, y1 - y0) * 1.35, tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, tz: 0 }); }
  }

  /* ---------------- janela da simulação ---------------- */
  let S = null;
  const fmt = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function colorsOf(o) { const m = MATS[o.material.mat] || MATS.mdf; return o.material.mat === 'custom' ? { top: o.material.top || '#c49a6c', core: o.material.core || '#a97c50' } : m; }

  function open(o) {
    close();
    const plan = parse(o.files, o.tools, { ...o, th: o.sheet.th, sheetW: o.sheet.w, sheetH: o.sheet.h });
    if (!plan.moves.length) throw Error('O G-code não tem movimentos para simular.');
    const stock = new Stock(o.sheet.w, o.sheet.h, o.sheet.th, o.over);
    const sim = new Sim(plan, stock);
    S = { o, plan, stock, sim, mode: '2d', play: false, speed: 20, path: true, last: 0, raf: 0, v2: null, v3: null, drag: null };
    $('#simTitle').textContent = o.title;
    $('#simMat').innerHTML = Object.entries(MATS).map(([k, m]) => `<option value="${k}" ${k === o.material.mat ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    $('#simTop').value = colorsOf(o).top; $('#simCore').value = colorsOf(o).core; $('#simCustom').hidden = o.material.mat !== 'custom';
    $('#simTotal').textContent = fmt(plan.total); $('#simSeek').max = 1000; $('#simSeek').value = 0;
    $('#simSpeed').value = String(S.speed); $('#simPath').checked = true;
    const m = $('#simModal'); m._ret = document.activeElement; m.hidden = false;
    setMode('2d'); setPlay(false); loop(); $('#simPlay').focus();
  }
  function close() { if (!S) return; cancelAnimationFrame(S.raf); const m = $('#simModal'); m.hidden = true; const r = m._ret; S = null; if (r && r.isConnected && r.focus) r.focus(); }
  function size() { const cv = S.mode === '3d' ? $('#sim3d') : $('#sim2d'), b = cv.parentElement.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); const w = Math.max(10, Math.round(b.width * d)), h = Math.max(10, Math.round(b.height * d)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; } return false; }
  function view() { return S.mode === '3d' ? S.v3 : S.v2; }
  function setMode(md) {
    if (md === '3d' && !S.v3) {
      try { S.v3 = new View3D($('#sim3d'), S.stock, S.plan, colorsOf(S.o)); }
      catch (e) { $('#simInfo').textContent = e.message; md = '2d'; }
    }
    S.mode = md; $('#sim2d').hidden = md !== '2d'; $('#sim3d').hidden = md !== '3d';
    document.querySelectorAll('[data-simmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.simmode === md)));
    if (md === '2d' && !S.v2) { size(); S.v2 = new View2D($('#sim2d'), S.stock, S.plan, colorsOf(S.o)); }
    S.stock.dirty = [0, 0, S.stock.nx - 1, S.stock.ny - 1];   // a outra vista precisa do mapa inteiro
    if (size() && md === '2d') S.v2.fit();
    $('#simHint').textContent = md === '3d' ? 'Arraste para girar · Shift ou botão direito para mover · roda para aproximar' : 'Arraste para mover · roda para aproximar';
  }
  function setPlay(on) { S.play = on && S.sim.t < S.plan.total; $('#simPlay').textContent = S.play ? 'Pausar' : (S.sim.t >= S.plan.total ? 'Ver de novo' : 'Simular'); S.last = performance.now(); }
  function info() {
    const sim = S.sim, mv = sim.current();
    $('#simNow').textContent = fmt(sim.t); $('#simSeek').value = String(Math.round(sim.t / (S.plan.total || 1) * 1000));
    const t = mv && mv.tool;
    $('#simTool').textContent = t ? `T${t.num} · ${t.name} · Ø${t.dia} mm` : '—';
    $('#simLine').textContent = mv ? `Arquivo ${mv.file + 1} · linha ${mv.line}: ${mv.src}` : '';
    $('#simWarn').textContent = sim.hits.length ? `${sim.hits.length} movimento(s) rápido(s) dentro do material (colisão). Primeiro: arquivo ${sim.hits[0].file + 1}, linha ${sim.hits[0].line}.` : '';
  }
  function loop() {
    if (!S) return;
    const now = performance.now();
    if (S.play) { S.sim.seek(S.sim.t + (now - S.last) / 1000 * S.speed); if (S.sim.t >= S.plan.total) setPlay(false); }
    S.last = now;
    if (size() && S.mode === '2d') S.v2.fit();
    const p = S.sim.toolPos(), mv = S.sim.current();
    view().draw(p ? [p[0], p[1], p[2], mv && mv.tool ? mv.tool.dia / 2 : 3] : null, S.path);
    info();
    S.raf = requestAnimationFrame(loop);
  }

  function bind() {
    $('#simX').onclick = close;
    $('#simPlay').onclick = () => { if (S.sim.t >= S.plan.total) S.sim.restart(); setPlay(!S.play); };
    $('#simStart').onclick = () => { S.sim.restart(); setPlay(false); };
    $('#simEnd').onclick = () => { S.sim.seek(S.plan.total); setPlay(false); };
    $('#simSpeed').onchange = e => { S.speed = +e.target.value; };
    $('#simSeek').oninput = e => { S.sim.seek(+e.target.value / 1000 * S.plan.total); setPlay(false); };
    $('#simPath').onchange = e => { S.path = e.target.checked; };
    $('#simFit').onclick = () => view().fit();
    document.querySelectorAll('[data-simmode]').forEach(b => { b.onclick = () => setMode(b.dataset.simmode); });
    const mat = () => { const k = $('#simMat').value; S.o.material = { mat: k, top: $('#simTop').value, core: $('#simCore').value }; $('#simCustom').hidden = k !== 'custom';
      if (k !== 'custom') { $('#simTop').value = MATS[k].top; $('#simCore').value = MATS[k].core; }
      const c = colorsOf(S.o); if (S.v2) S.v2.setColors(c); if (S.v3) S.v3.setColors(c); S.stock.dirty = [0, 0, S.stock.nx - 1, S.stock.ny - 1]; if (S.o.onMaterial) S.o.onMaterial(S.o.material); };
    $('#simMat').onchange = mat; $('#simTop').oninput = mat; $('#simCore').oninput = mat;
    const area = $('#simArea');
    area.addEventListener('contextmenu', e => e.preventDefault());
    area.addEventListener('pointerdown', e => { if (!S) return; area.setPointerCapture(e.pointerId); S.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || S.mode === '2d' }; });
    area.addEventListener('pointermove', e => { if (!S || !S.drag) return; const d = Math.min(2, devicePixelRatio || 1), dx = (e.clientX - S.drag.x) * d, dy = (e.clientY - S.drag.y) * d; S.drag.x = e.clientX; S.drag.y = e.clientY;
      if (S.drag.pan) view().pan(dx, dy); else S.v3.orbit(dx, dy); });
    area.addEventListener('pointerup', () => { if (S) S.drag = null; });
    area.addEventListener('wheel', e => { if (!S) return; e.preventDefault(); const r = area.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); view().zoomAt((e.clientX - r.left) * d, (e.clientY - r.top) * d, e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    document.addEventListener('keydown', e => { if (!S) return; if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') { e.preventDefault(); $('#simPlay').click(); } }, true);
  }
  const api = { open, close, _parse: parse, _Stock: Stock, _Sim: Sim, MATS };
  if (typeof document !== 'undefined' && document.querySelector('#simModal')) { bind(); window.CamSim = api; }
  else if (typeof module !== 'undefined') module.exports = api;   // tests/sim_check.js
})();
