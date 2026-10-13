"""Persistência em JSON no servidor.

Arquivos (pasta `data/`, ou a variável NEST_DATA):
  store.json          projetos, modelos (cores), presets, histórico, exportações, configurações
  project_<id>.json   peças, arquivos de origem e contadores de sequência de um projeto
Toda gravação é atômica (temporário + os.replace) e guarda a versão anterior em .bak.
Se o arquivo principal estiver corrompido, o .bak é usado e o arquivo ruim é preservado ao lado.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = threading.RLock()
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HISTORY_MAX = 5000
EDITABLE = ("projects", "models", "presets", "settings")
DEFAULT_SETTINGS = {"naming": "{projeto}_{material}_{espessura}MM_{seq}"}


class Conflict(Exception):
    """A revisão enviada não é a gravada: outra janela alterou os dados."""


class BadId(ValueError):
    pass


def data_dir() -> Path:
    path = Path(os.environ.get("NEST_DATA") or ROOT / "data")
    path.mkdir(parents=True, exist_ok=True)
    return path


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def empty() -> dict:
    return {
        "version": 1, "rev": 0, "projects": [], "models": [], "presets": [],
        "history": [], "exports": [], "settings": dict(DEFAULT_SETTINGS),
    }


def check_id(value) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise BadId("Identificador inválido.")
    return value


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    if path.exists():
        path.with_name(path.name + ".bak").write_bytes(path.read_bytes())
    os.replace(tmp, path)


def _read_safe(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        try:
            doc = json.loads(path.with_name(path.name + ".bak").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            doc = None
        path.rename(path.with_name("%s.corrompido-%d" % (path.name, int(time.time()))))
        return doc


def load() -> dict:
    with LOCK:
        doc = _read_safe(data_dir() / "store.json") or {}
        base = empty()
        base.update({k: v for k, v in doc.items() if k in base})
        base["settings"] = {**DEFAULT_SETTINGS, **(base.get("settings") or {})}
        return base


def _write(doc: dict) -> None:
    atomic_write(data_dir() / "store.json", json.dumps(doc, ensure_ascii=False))


def save(patch: dict, base_rev: int) -> dict:
    """Aplica só as chaves editáveis. Histórico e exportações só crescem pelo servidor (log)."""
    with LOCK:
        doc = load()
        if int(base_rev) != doc["rev"]:
            raise Conflict("Os dados mudaram em outra janela. Recarregue a página.")
        for key in EDITABLE:
            if key in patch:
                doc[key] = patch[key]
        doc["rev"] += 1
        _write(doc)
        return {"rev": doc["rev"]}


def log(kind: str, detail: dict | None = None, project: str = "") -> dict:
    with LOCK:
        doc = load()
        entry = {"t": now(), "kind": str(kind)[:60], "project": str(project)[:64], "detail": detail or {}}
        doc["history"] = (doc["history"] + [entry])[-HISTORY_MAX:]
        if kind == "export":
            doc["exports"] = doc["exports"] + [entry]
        _write(doc)  # o histórico não muda `rev`: ele só controla os dados editáveis
        return {"rev": doc["rev"]}


def load_project(pid: str) -> dict:
    check_id(pid)
    with LOCK:
        doc = _read_safe(data_dir() / ("project_%s.json" % pid))
        return doc or {"parts": [], "files": [], "uid": 0, "seq": {}, "groups": {}}


def save_project(pid: str, payload: dict) -> None:
    check_id(pid)
    with LOCK:
        atomic_write(data_dir() / ("project_%s.json" % pid), json.dumps(payload, ensure_ascii=False))
