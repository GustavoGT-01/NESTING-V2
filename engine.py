"""Escolhe o motor de encaixe e acompanha encaixes em andamento.

O motor compilado (pasta `motor/`, em Rust) usa o mesmo método do `nest.py` e dá as
mesmas posições para a mesma ordem de peças, só que dezenas de vezes mais rápido.
Quando o executável não existe ou falha, o encaixe segue pelo `nest.py`.

Um encaixe pode rodar de uma vez (`nest_all`) ou como tarefa (`start`): a tarefa
guarda a melhor solução achada até o momento, para a tela mostrar a prévia, e pode
ser parada antes do prazo ficando com o melhor até ali.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import nest

ROOT = Path(__file__).resolve().parent
EXE = "motor.exe" if os.name == "nt" else "motor"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
JOBS: dict = {}
JOBS_LOCK = threading.Lock()
KEEP = 600  # segundos que uma tarefa terminada fica disponível


def find_motor() -> str | None:
    """Caminho do motor compilado: variável NEST_MOTOR, ao lado do programa ou na pasta de build."""
    env = os.environ.get("NEST_MOTOR", "").strip()
    for candidate in (env, ROOT / EXE, ROOT / "motor" / "target" / "release" / EXE):
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


def run_motor(tool: str, payload: dict, workers: int) -> dict:
    body = dict(payload, workers=int(payload.get("workers", 0)) or workers)
    seconds = float(payload.get("seconds", 20))
    done = subprocess.run(
        [tool],
        input=json.dumps(body).encode("utf-8"),
        capture_output=True,
        timeout=seconds * 3 + 60,
        creationflags=FLAGS,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", errors="replace").strip() or "motor compilado falhou")
    return json.loads(done.stdout.decode("utf-8"))


def _python(payload: dict, pool, workers: int) -> dict:
    out = nest.nest_all(payload, pool, workers)
    for res in out.values():
        res["engine"] = "python"
    return out


def nest_all(payload: dict, pool=None, workers: int = 1, motor: str = "auto") -> dict:
    """motor: "auto" (compilado se houver), "rust" (exige o compilado) ou "python"."""
    tool = find_motor() if motor != "python" else None
    if motor == "rust" and not tool:
        raise RuntimeError("Motor compilado não encontrado. Rode `cargo build --release` na pasta motor/.")
    if tool:
        try:
            return run_motor(tool, payload, workers)
        except Exception as exc:
            if motor == "rust":
                raise
            print("Motor compilado falhou (%s); usando o nest.py." % exc, file=sys.stderr)
    return _python(payload, pool, workers)


class Job:
    """Um encaixe em andamento. `best` é a melhor solução de cada grupo até agora."""

    def __init__(self, payload: dict, pool, workers: int):
        self.id = uuid.uuid4().hex
        self.seconds = float(payload.get("seconds", 20))
        self.started = time.time()
        self.ended = None
        self.best: dict = {}
        self.rev = 0
        self.result = None
        self.error = ""
        self.engine = "python"
        self.proc = None
        self.stop_file = Path(tempfile.gettempdir()) / ("nest-stop-%s" % self.id)
        self.lock = threading.Lock()
        threading.Thread(target=self._run, args=(payload, pool, workers), daemon=True).start()

    def _run(self, payload: dict, pool, workers: int) -> None:
        try:
            tool = find_motor()
            if tool:
                try:
                    self.engine = "rust"
                    self.result = self._rust(tool, payload, workers)
                    return
                except Exception as exc:
                    print("Motor compilado falhou (%s); usando o nest.py." % exc, file=sys.stderr)
                    self.engine = "python"
            self.result = _python(payload, pool, workers)
        except Exception as exc:
            self.error = str(exc) or "falha no encaixe"
        finally:
            self.ended = time.time()
            try:
                self.stop_file.unlink()
            except OSError:
                pass

    def _rust(self, tool: str, payload: dict, workers: int) -> dict:
        body = dict(
            payload,
            workers=int(payload.get("workers", 0)) or workers,
            progress=True,
            stop_file=str(self.stop_file),
        )
        self.proc = subprocess.Popen(
            [tool], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=FLAGS
        )
        self.proc.stdin.write(json.dumps(body).encode("utf-8"))
        self.proc.stdin.close()
        final = None
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            doc = json.loads(line)
            step = doc.get("progress") if len(doc) == 1 else None
            if isinstance(step, dict) and "key" in step and "sheets" in step:
                with self.lock:
                    self.best[step.pop("key")] = step
                    self.rev += 1
            else:
                final = doc
        err = self.proc.stderr.read().decode("utf-8", errors="replace").strip()
        if self.proc.wait() != 0 or final is None:
            raise RuntimeError(err or "motor compilado falhou")
        return final

    def stop(self) -> None:
        """Pede ao motor para fechar com o melhor até agora (só o compilado atende)."""
        try:
            self.stop_file.touch()
        except OSError:
            pass

    def status(self, rev: int = -1) -> dict:
        with self.lock:
            out = {
                "id": self.id,
                "done": self.ended is not None,
                "elapsed": round((self.ended or time.time()) - self.started, 1),
                "seconds": self.seconds,
                "engine": self.engine,
                "rev": self.rev,
            }
            if self.error:
                out["error"] = self.error
            elif self.result is not None:
                out["result"] = self.result
            elif self.rev != rev:
                out["best"] = dict(self.best)
            return out


def start(payload: dict, pool=None, workers: int = 1) -> Job:
    job = Job(payload, pool, workers)
    now = time.time()
    with JOBS_LOCK:
        for key in [k for k, j in JOBS.items() if j.ended and now - j.ended > KEEP]:
            del JOBS[key]
        JOBS[job.id] = job
    return job


def get(job_id: str) -> Job | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)
