"""Servidor local. Converte DWG em DXF, calcula o encaixe e entrega a página."""

from __future__ import annotations

import json
import multiprocessing
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import engine
import eps
import store

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8080
MAX_BODY = 100 * 1024 * 1024  # maior corpo de POST aceito (DWG grande cabe folgado)
CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)
WORKERS = max(1, int(os.environ.get("NEST_WORKERS", "0") or 0) or (os.cpu_count() or 1))
POOL = None


def find_oda() -> str | None:
    env = os.environ.get("ODA_FILE_CONVERTER", "").strip()
    candidates = [
        env,
        r"C:\Program Files\ODA\ODAFileConverter\ODAFileConverter.exe",
        r"C:\Program Files\ODA\ODAFileConverter 26.7.0\ODAFileConverter.exe",
        r"C:\Program Files\ODA\ODAFileConverter 25.12.0\ODAFileConverter.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    root = Path(r"C:\Program Files\ODA")
    if root.is_dir():
        found = sorted(root.glob("*/ODAFileConverter.exe"))
        if found:
            return str(found[-1])
    return shutil.which("ODAFileConverter.exe") or shutil.which("dwg2dxf")


def dxf_to_dwg(text: str) -> bytes:
    tool = find_oda()
    if not tool:
        raise RuntimeError(
            "Exportar DWG precisa do ODA File Converter nesta máquina."
        )
    if Path(tool).name.lower().startswith("dwg2dxf"):
        raise RuntimeError("O conversor instalado só lê DWG. Exportar DWG pede o ODA File Converter.")
    in_dir = Path(tempfile.mkdtemp(prefix="nest-dxf-in-"))
    out_dir = Path(tempfile.mkdtemp(prefix="nest-dxf-out-"))
    try:
        staged = in_dir / "encaixe.dxf"
        staged.write_text(text, encoding="utf-8")
        subprocess.run(
            [tool, str(in_dir), str(out_dir), "ACAD2013", "DWG", "0", "1", "encaixe.dxf"],
            check=True,
            capture_output=True,
            timeout=120,
        )
        found = list(out_dir.rglob("*.dwg"))
        if not found:
            raise RuntimeError("O conversor não gerou o DWG.")
        return found[0].read_bytes()
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "Falha ao gerar o DWG.") from exc
    finally:
        shutil.rmtree(in_dir, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)


def dwg_to_dxf(data: bytes, filename: str) -> str:
    tool = find_oda()
    if not tool:
        raise RuntimeError(
            "DWG precisa do ODA File Converter nesta máquina. "
            "Instale o conversor gratuito da Open Design Alliance e tente de novo."
        )
    safe = Path(filename).name or "peca.dwg"
    if not safe.lower().endswith(".dwg"):
        safe += ".dwg"
    in_dir = Path(tempfile.mkdtemp(prefix="nest-dwg-in-"))
    out_dir = Path(tempfile.mkdtemp(prefix="nest-dwg-out-"))
    try:
        staged = in_dir / safe
        staged.write_bytes(data)
        if Path(tool).name.lower().startswith("dwg2dxf"):
            dest = out_dir / (staged.stem + ".dxf")
            subprocess.run([tool, "-o", str(dest), str(staged)], check=True, capture_output=True, timeout=120)
        else:
            subprocess.run(
                [tool, str(in_dir), str(out_dir), "ACAD2010", "DXF", "0", "1", safe],
                check=True,
                capture_output=True,
                timeout=120,
            )
        found = list(out_dir.rglob("*.dxf"))
        if not found:
            raise RuntimeError("O conversor não gerou DXF para este DWG.")
        return found[0].read_text(encoding="utf-8", errors="replace")
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "Falha ao converter o DWG.") from exc
    finally:
        shutil.rmtree(in_dir, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # A página muda entre versões: o navegador não deve reaproveitar uma cópia antiga.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def _local(self) -> set:
        port = self.server.server_address[1]
        return {"127.0.0.1:%d" % port, "localhost:%d" % port}

    def _host_ok(self) -> bool:
        # Host estranho = outro site apontando um domínio para 127.0.0.1 (DNS rebinding)
        host = self.headers.get("Host")
        if host is None or host in self._local():
            return True
        self._fail(421, "Host não aceito.")
        return False

    def _static(self) -> bool:
        # só a página é servida; dados, código e .git ficam de fora
        if self.path.split("?", 1)[0] in ("/", "/index.html"):
            self.path = "/index.html"
            return True
        self.send_error(404)
        return False

    def do_HEAD(self):
        if self._host_ok() and self._static():
            super().do_HEAD()

    def _json(self, obj, status: int = 200) -> None:
        try:
            raw = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError):
            return self._fail(500, "resposta inválida (número não finito ou tipo não serializável)")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self._host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/store":
            try:
                return self._json(store.load())
            except ValueError as exc:  # dados corrompidos sem cópia: avisa em vez de mostrar vazio
                return self._fail(500, str(exc))
        elif path.startswith("/api/project/"):
            try:
                return self._json(store.load_project(path.rsplit("/", 1)[1]))
            except store.BadId as exc:
                return self._fail(400, str(exc))
            except ValueError as exc:
                return self._fail(500, str(exc))
        elif path.startswith("/api/nest/poll/"):
            job = engine.get(path.rsplit("/", 1)[1])
            if job is None:
                return self._fail(404, "Encaixe não encontrado (o servidor foi reiniciado?).")
            query = self.path.partition("?")[2]
            rev = next((v for k, _, v in (p.partition("=") for p in query.split("&")) if k == "rev"), "")
            return self._json(job.status(int(rev) if rev.lstrip("-").isdigit() else -1))
        if self._static():
            super().do_GET()

    def _fail(self, status: int, message: str) -> None:
        body = message.encode("utf-8")
        if status >= 400:
            self.close_connection = True  # o corpo do pedido pode ter ficado sem ler
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._host_ok():
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {"http://" + h for h in self._local()}:
            return self._fail(403, "Origem não aceita.")  # outro site postando no servidor local
        try:
            length = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            return self._fail(400, "Content-Length ausente ou inválido.")
        if length > MAX_BODY:
            return self._fail(413, "Arquivo grande demais.")
        path = self.path.split("?", 1)[0]
        data = self.rfile.read(length) if length else b""
        if path == "/api/dwg":
            name = self.headers.get("X-Filename", "peca.dwg")
            try:
                raw = dwg_to_dxf(data, name).encode("utf-8")
                mime = "text/plain; charset=utf-8"
            except Exception as exc:
                self._fail(400, str(exc))
                return
        elif path == "/api/nest":
            try:
                raw = json.dumps(engine.nest_all(json.loads(data.decode("utf-8")), POOL, WORKERS)).encode("utf-8")
                mime = "application/json; charset=utf-8"
            except Exception as exc:
                self._fail(400, "Falha no encaixe: %s" % exc)
                return
        elif path == "/api/nest/start":
            # encaixe como tarefa: a página acompanha a prévia por /api/nest/poll/<id>
            try:
                self._json({"id": engine.start(json.loads(data.decode("utf-8")), POOL, WORKERS).id})
            except engine.Busy as exc:
                self._fail(429, str(exc))
            except Exception as exc:
                self._fail(400, "Falha no encaixe: %s" % exc)
            return
        elif path.startswith("/api/nest/stop/"):
            job = engine.get(path.rsplit("/", 1)[1])
            if job is None:
                self._fail(404, "Encaixe não encontrado.")
            else:
                job.stop()
                self._json({"ok": True})
            return
        elif path == "/api/store":
            try:
                body = json.loads(data.decode("utf-8"))
                self._json(store.save(body.get("patch", {}), body.get("rev", -1)))
            except store.Conflict as exc:
                self._fail(409, str(exc))
            except Exception as exc:
                self._fail(400, "Falha ao gravar: %s" % exc)
            return
        elif path.startswith("/api/project/"):
            try:
                rev = store.save_project(path.rsplit("/", 1)[1], json.loads(data.decode("utf-8")))
                self._json(dict(ok=True, rev=rev) if isinstance(rev, int) else {"ok": True})
            except store.Conflict as exc:
                self._fail(409, str(exc))
            except Exception as exc:
                self._fail(400, "Falha ao gravar o projeto: %s" % exc)
            return
        elif path == "/api/history":
            try:
                body = json.loads(data.decode("utf-8"))
                self._json(store.log(body.get("kind", ""), body.get("detail"), body.get("project", "")))
            except Exception as exc:
                self._fail(400, str(exc))
            return
        elif path == "/api/eps":
            try:
                body = json.loads(data.decode("utf-8"))
                opts = body.get("opts", {})
                files = []
                for item in body["sheets"]:
                    sheet = item["sheet"]
                    text = eps.build_eps(sheet, item.get("title", "Encaixe"), bool(opts.get("colors")), bool(opts.get("frame")))
                    files.append({"name": item["name"], "eps": text, "check": eps.validate(text, sheet)})
                self._json({"files": files})
            except Exception as exc:
                self._fail(400, "Falha ao gerar o EPS: %s" % exc)
            return
        elif path == "/api/dxf-dwg":
            try:
                raw = dxf_to_dwg(data.decode("utf-8", errors="replace"))
                mime = "application/acad"
            except Exception as exc:
                self._fail(400, str(exc))
                return
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        if "/api/nest/poll/" in self.path:
            return  # consulta repetida a cada meio segundo: não polui o registro
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


class Server(ThreadingHTTPServer):
    # Sem reaproveitar a porta: no Windows um segundo servidor ligaria na mesma porta sem erro.
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    global POOL
    os.chdir(ROOT)
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        print(f"Já existe um servidor na porta {PORT}: use a janela aberta ou feche-a")
        sys.exit(1)
    try:
        store.snapshot()
    except Exception as exc:  # backup nunca impede o servidor de subir
        print("Aviso: backup diário dos dados falhou: %s" % exc)
    POOL =ProcessPoolExecutor(max_workers=WORKERS)
    print(f"Encaixe: {WORKERS} núcleos do processador em uso.")
    print(f"Aberto em http://{HOST}:{PORT}")
    print("Motor de encaixe: compilado (Rust)." if engine.find_motor() else "Motor de encaixe: Python (o compilado não foi encontrado).")
    if find_oda():
        print("DWG: conversor encontrado.")
    else:
        print("DWG: ODA File Converter não encontrado. DXF e SVG seguem normais.")
    server.serve_forever()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
