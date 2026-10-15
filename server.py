"""Servidor local. Converte DWG em DXF, calcula o encaixe e entrega a página."""

from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import multiprocessing
import os
import shutil
import socket
import subprocess
import sys
import secrets
import tempfile
import threading
import time
from logging.handlers import RotatingFileHandler
from concurrent.futures import ProcessPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

import engine
import eps
import store

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8080
MAX_BODY = 100 * 1024 * 1024  # maior corpo de POST aceito (DWG grande cabe folgado)
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)
WORKERS = max(1, int(os.environ.get("NEST_WORKERS", "0") or 0) or (os.cpu_count() or 1))
POOL = None

# Acesso pela rede (data/rede.json). Fora da máquina tudo exige o PIN; a própria máquina entra direto.
NET_ON = False          # estado em uso: só muda ao religar o servidor (é ele que escolhe a interface)
SESSIONS: dict = {}     # cookie -> validade
FAILS: dict = {}        # IP -> [erros, bloqueado até]
NET_LOCK = threading.RLock()
SESSION_DAYS = 30
COOKIE = "nest_s"
LOGIN_PAGE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Encaixe Chapa</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#f1f5f9;font:16px system-ui,sans-serif}
form{background:#151d27;border:1px solid #283444;border-radius:14px;padding:28px;width:min(320px,calc(100vw - 32px));box-sizing:border-box;display:grid;gap:14px}
h1{font-size:20px;margin:0}p{margin:0;color:#9aa9ba;font-size:14px}input{font:inherit;font-size:22px;letter-spacing:.3em;text-align:center;padding:10px;border-radius:10px;border:1px solid #3a4a60;background:#0d131b;color:inherit}
button{font:inherit;font-weight:600;padding:11px;border:0;border-radius:10px;background:#38bdf8;color:#04121c;cursor:pointer}.e{color:#f87171}</style></head>
<body><form method="post" action="/api/login"><h1>Encaixe Chapa</h1><p>Digite o PIN mostrado no computador principal, em Presets &rsaquo; Acesso pela rede.</p>
%s<input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus aria-label="PIN"><button>Entrar</button></form></body></html>"""


def _net_path() -> Path:
    return store.data_dir() / "rede.json"


def net_config() -> dict:
    """{"on": bool, "pin": "6 dígitos"}; cria com PIN aleatório na primeira leitura."""
    with NET_LOCK:
        try:
            cfg = json.loads(_net_path().read_text(encoding="utf-8"))
            if isinstance(cfg, dict) and isinstance(cfg.get("pin"), str) and cfg["pin"].isdigit() and len(cfg["pin"]) >= 6:
                return {"on": cfg.get("on") is True, "pin": cfg["pin"]}
        except (OSError, ValueError):
            pass
        cfg = {"on": False, "pin": "%06d" % secrets.randbelow(10**6)}
        _net_path().parent.mkdir(parents=True, exist_ok=True)
        store.atomic_write(_net_path(), json.dumps(cfg))
        return cfg


def net_save(on=None, new_pin: bool = False) -> dict:
    with NET_LOCK:
        cfg = net_config()
        if on is not None:
            cfg["on"] = bool(on)
        if new_pin:
            cfg["pin"] = "%06d" % secrets.randbelow(10**6)
            SESSIONS.clear()  # PIN novo derruba quem entrou com o antigo
        store.atomic_write(_net_path(), json.dumps(cfg))
    return cfg


def lan_addresses() -> list:
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return []
    return sorted({i[4][0] for i in infos if not i[4][0].startswith(("127.", "169.254."))})


def check_pin(ip: str, pin: str, now: float | None = None) -> str | None:
    """Token de sessão se o PIN confere; None se errado ou IP bloqueado (5 erros = 5 minutos parado)."""
    now = time.time() if now is None else now
    with NET_LOCK:
        real = net_config()["pin"]
        count, until = FAILS.get(ip, [0, 0.0])
        if until > now:
            return None
        if not hmac.compare_digest(pin.encode("utf-8"), real.encode("utf-8")):
            count += 1
            FAILS[ip] = [0, now + 300] if count >= 5 else [count, 0.0]
            return None
        FAILS.pop(ip, None)
        for tok in [t for t, exp in SESSIONS.items() if exp < now]:
            del SESSIONS[tok]
        if len(SESSIONS) >= 200:  # teto: descarta a sessão mais antiga
            del SESSIONS[min(SESSIONS, key=SESSIONS.get)]
        token = secrets.token_urlsafe(32)
        SESSIONS[token] = now + SESSION_DAYS * 86400
        return token


def session_ok(cookie_header: str | None) -> bool:
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE and value:
            with NET_LOCK:
                exp = SESSIONS.get(value)
            return exp is not None and exp > time.time()
    return False


def ip_host(host: str, port: int) -> bool:
    """Host "IPv4:porta": um IP literal não sofre DNS rebinding, por isso pode vir da rede."""
    name, _, p = host.rpartition(":")
    try:
        return p == str(port) and ipaddress.ip_address(name).version == 4
    except ValueError:
        return False


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
        self.send_header("Referrer-Policy", "same-origin")  # no-referrer faz o form de PIN mandar Origin: null
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def _local(self) -> set:
        port = self.server.server_address[1]
        return {"127.0.0.1:%d" % port, "localhost:%d" % port}

    def _host_ok(self) -> bool:
        # Host estranho = outro site apontando um domínio para 127.0.0.1 (DNS rebinding)
        host = self.headers.get("Host")
        if host is None or host in self._local() or (NET_ON and ip_host(host, self.server.server_address[1])):
            return True
        self._fail(421, "Host não aceito.")
        return False

    def _remote(self) -> bool:
        try:
            return not ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return True

    def _auth_ok(self) -> bool:
        """Quem vem da rede precisa da sessão aberta com o PIN; sem ela, a página de entrada."""
        if not self._remote():
            return True
        if not NET_ON:
            self._fail(403, "Acesso pela rede desligado.")
            return False
        if session_ok(self.headers.get("Cookie")):
            return True
        if self.command == "GET" and self.path.split("?", 1)[0] in ("/", "/index.html"):
            self._login_page("")
        else:
            self._fail(401, "Entre com o PIN.")
        return False

    def _login_page(self, error: str) -> None:
        raw = (LOGIN_PAGE % ('<p class="e">%s</p>' % error if error else "")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _static(self) -> bool:
        # só a página é servida; dados, código e .git ficam de fora
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.path = "/index.html"
            return True
        if path == "/app.js":  # o script da página; nada mais sai da pasta
            return True
        self.send_error(404)
        return False

    def do_HEAD(self):
        if self._host_ok() and self._auth_ok() and self._static():
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
        if not self._host_ok() or not self._auth_ok():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/rede":
            if self._remote():
                return self._fail(403, "Só no computador principal.")
            cfg = net_config()
            return self._json({"on": cfg["on"], "pin": cfg["pin"], "active": NET_ON,
                               "urls": ["http://%s:%d" % (a, self.server.server_address[1]) for a in lan_addresses()]})
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
        elif path == "/api/history":
            query = self.path.partition("?")[2]
            args = {}
            for part in query.split("&"):
                if not part:
                    continue
                key, _, val = part.partition("=")
                args[key] = val
            try:
                offset = int(args["offset"]) if args.get("offset") else 0
                limit = int(args["limit"]) if args.get("limit") else 50
                return self._json(store.read_history(offset, limit, args.get("bucket") or "history"))
            except (ValueError, KeyError) as exc:
                return self._fail(400, str(exc) or "consulta inválida")
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
        try:
            length = int(self.headers.get("Content-Length"))
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            return self._fail(400, "Content-Length ausente ou inválido.")
        if length > MAX_BODY:
            return self._fail(413, "Arquivo grande demais.")
        # o corpo é lido antes de qualquer recusa: fechar a conexão com dados por ler vira RST no Windows
        # e o cliente vê "conexão abortada" em vez da resposta
        data = self.rfile.read(length) if length else b""
        if not self._host_ok():
            return
        origin = self.headers.get("Origin")
        allowed = {"http://" + h for h in self._local()} | {"http://" + (self.headers.get("Host") or "")}
        if origin is not None and origin not in allowed:
            return self._fail(403, "Origem não aceita.")  # outro site postando no servidor
        path = self.path.split("?", 1)[0]
        if path == "/api/login":
            if not (self._remote() and NET_ON):
                return self._fail(403, "Acesso pela rede desligado.")
            pin = (parse_qs(data.decode("utf-8", "replace")).get("pin") or [""])[0].strip()
            token = check_pin(self.client_address[0], pin)
            if token is None:
                return self._login_page("PIN errado. Depois de 5 erros, espere 5 minutos.")
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d" % (COOKIE, token, SESSION_DAYS * 86400))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self._auth_ok():
            return
        if path == "/api/rede":
            if self._remote():
                return self._fail(403, "Só no computador principal.")
            try:
                body = json.loads(data.decode("utf-8") or "{}")
                cfg = net_save(body["on"] if isinstance(body.get("on"), bool) else None, body.get("newpin") is True)
            except (ValueError, AttributeError, OSError) as exc:
                return self._fail(400, "Falha ao gravar: %s" % exc)
            return self._json({"on": cfg["on"], "pin": cfg["pin"], "active": NET_ON})
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
        elif path.startswith("/api/project/") and path.endswith("/delete"):
            try:
                self._json({"ok": True, "file": store.delete_project(path.split("/")[3])})
            except Exception as exc:
                self._fail(400, "Falha ao excluir o projeto: %s" % exc)
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
        line = fmt % args  # a mesma linha do console: caminho do pedido, sem corpo
        print("[%s] %s" % (self.log_date_time_string(), line))
        _file_log().info(line)


def _file_log() -> logging.Logger:
    lg = logging.getLogger("nest.server")
    folder = store.data_dir() / "logs"
    target = str(folder / "server.log")
    if lg.handlers and getattr(lg, "_nest_path", None) == target:
        return lg
    for old in list(lg.handlers):
        lg.removeHandler(old)
        old.close()
    folder.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(target, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    lg.setLevel(logging.INFO)
    lg.addHandler(handler)
    lg.propagate = False
    lg._nest_path = target
    return lg


class Server(ThreadingHTTPServer):
    # Sem reaproveitar a porta: no Windows um segundo servidor ligaria na mesma porta sem erro.
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    global POOL, NET_ON
    os.chdir(ROOT)
    NET_ON = net_config()["on"]
    try:
        server = Server(("0.0.0.0" if NET_ON else HOST, PORT), Handler)
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
    if NET_ON:
        print("Acesso pela rede ligado (com PIN): " + ", ".join("http://%s:%d" % (a, PORT) for a in lan_addresses()))
    print("Motor de encaixe: compilado (Rust)." if engine.find_motor() else "Motor de encaixe: Python (o compilado não foi encontrado).")
    if find_oda():
        print("DWG: conversor encontrado.")
    else:
        print("DWG: ODA File Converter não encontrado. DXF e SVG seguem normais.")
    server.serve_forever()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
