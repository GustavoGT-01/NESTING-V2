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
import math
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
MAX_RUNNING = 2  # encaixes simultâneos: cada um já usa todos os núcleos


class Busy(Exception):
    """Já há encaixes demais rodando."""


def _limits(payload: dict, workers: int) -> dict:
    """O pedido vem da página: prazo finito e núcleos limitados aos da máquina."""
    try:
        seconds = float(payload.get("seconds", 20))
        want = int(payload.get("workers", 0)) or workers
    except (TypeError, ValueError):
        raise ValueError("Tempo de otimização ou núcleos inválidos.") from None
    if not (math.isfinite(seconds) and 0 < seconds <= 7200):
        raise ValueError("O tempo de otimização precisa ficar entre 0 e 7200 segundos.")
    return dict(payload, seconds=seconds, workers=max(1, min(want, os.cpu_count() or 1)))


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


def _python(payload: dict, pool, workers: int, stop_file: str | None = None) -> dict:
    out = nest.nest_all(payload, pool, workers, stop_file=stop_file)
    for res in out.values():
        res["engine"] = "python"
    return out


def nest_all(payload: dict, pool=None, workers: int = 1, motor: str = "auto") -> dict:
    """motor: "auto" (compilado se houver), "rust" (exige o compilado) ou "python"."""
    payload = _limits(payload, workers)
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
        self.timed_out = False
        self.stopping = False
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
                    if self.timed_out:  # estouro de prazo é final: não refaz tudo no nest.py
                        raise
                    print("Motor compilado falhou (%s); usando o nest.py." % exc, file=sys.stderr)
                    self.engine = "python"
            self.result = _python(payload, pool, workers, str(self.stop_file))
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
        # stderr num arquivo: um PIPE cheio sem leitor travaria o motor e esta thread
        with tempfile.TemporaryFile() as errf:
            self.proc = subprocess.Popen(
                [tool], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf, creationflags=FLAGS
            )
            # prazo: motor travado é morto e o erro fica registrado
            late = threading.Event()
            limit = self.seconds * 3 + 60
            timer = threading.Timer(limit, lambda: (late.set(), self.proc.kill()))
            timer.start()
            final = None
            try:
                try:
                    self.proc.stdin.write(json.dumps(body).encode("utf-8"))
                    self.proc.stdin.close()
                except OSError as exc:  # motor morreu antes de ler a entrada: o motivo está no stderr
                    self.proc.kill()
                    self.proc.wait()
                    errf.seek(0)
                    err = errf.read().decode("utf-8", errors="replace").strip()
                    raise RuntimeError(err or "motor compilado fechou a entrada (%s)" % exc) from exc
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
                timer.cancel()
                code = self.proc.wait()
            except BaseException:
                self.proc.kill()
                self.proc.wait()
                raise
            finally:
                timer.cancel()
            errf.seek(0)
            err = errf.read().decode("utf-8", errors="replace").strip()
        if late.is_set() and code != 0:  # código 0: o timer disparou depois de o motor terminar bem
            self.timed_out = True
            raise RuntimeError("motor compilado passou do prazo de %.0f s e foi encerrado" % limit)
        if code != 0 or final is None:
            raise RuntimeError(err or "motor compilado falhou")
        return final

    def stop(self) -> None:
        """Pede para fechar com o melhor até agora. O compilado e o nest.py leem este arquivo."""
        self.stopping = True
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
    payload = _limits(payload, workers)
    now = time.time()
    with JOBS_LOCK:
        for key in [k for k, j in JOBS.items() if j.ended and now - j.ended > KEEP]:
            del JOBS[key]
        if sum(1 for j in JOBS.values() if j.ended is None and not j.stopping) >= MAX_RUNNING:
            raise Busy("Já há %d encaixes rodando: espere um terminar ou pare um deles." % MAX_RUNNING)
        job = Job(payload, pool, workers)
        JOBS[job.id] = job
    return job


def get(job_id: str) -> Job | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)
