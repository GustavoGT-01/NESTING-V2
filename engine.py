"""Escolhe o motor de encaixe.

O motor compilado (pasta `motor/`, em Rust) usa o mesmo método do `nest.py` e dá as
mesmas posições para a mesma ordem de peças, só que dezenas de vezes mais rápido.
Quando o executável não existe ou falha, o encaixe segue pelo `nest.py`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import nest

ROOT = Path(__file__).resolve().parent
EXE = "motor.exe" if os.name == "nt" else "motor"


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
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    done = subprocess.run(
        [tool],
        input=json.dumps(body).encode("utf-8"),
        capture_output=True,
        timeout=seconds * 3 + 60,
        creationflags=flags,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", errors="replace").strip() or "motor compilado falhou")
    return json.loads(done.stdout.decode("utf-8"))


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
    out = nest.nest_all(payload, pool, workers)
    for res in out.values():
        res["engine"] = "python"
    return out
