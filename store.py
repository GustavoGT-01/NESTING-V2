"""Persistência em JSON no servidor.

Arquivos (pasta `data/`, ou a variável NEST_DATA):
  store.json          projetos, modelos (cores), presets, configurações
  history.jsonl       histórico (uma linha por registro; um store.json antigo é copiado para cá)
  exports.jsonl       exportações, o mesmo formato
  project_<id>.json   peças, arquivos de origem e contadores de sequência de um projeto
Toda gravação é atômica (temporário + os.replace) e guarda a versão anterior em .bak.
Se o arquivo principal estiver corrompido, o .bak é usado e o arquivo ruim é preservado ao lado.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = threading.RLock()
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HISTORY_MAX = 5000
EXPORTS_MAX = 2000
DETAIL_MAX = 20000  # caracteres do detalhe serializado de um registro
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
        "settings": dict(DEFAULT_SETTINGS),
    }


def _log_path(bucket: str) -> Path:
    if bucket not in ("history", "exports"):
        raise ValueError("Registro inválido.")
    return data_dir() / ("%s.jsonl" % bucket)


def _log_lines(path: Path) -> list:
    if not path.exists():
        return []
    return [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def _append_many(bucket: str, entries: list, cap: int, skip_if_suffix: bool = False) -> None:
    """Acrescenta registros e corta no teto. skip_if_suffix evita duplicar numa migração repetida."""
    path = _log_path(bucket)
    existing = _log_lines(path)
    want = [json.dumps(item, ensure_ascii=False) for item in entries]
    if skip_if_suffix and want and len(existing) >= len(want) and existing[-len(want):] == want:
        return
    kept = (existing + want)[-cap:]
    _write_file(path, ("\n".join(kept) + ("\n" if kept else "")).encode("utf-8"))


def _migrate_logs(raw: dict) -> bool:
    """Copia history/exports do store.json para JSONL e tira as listas. Repetir não duplica."""
    changed = False
    for bucket, cap in (("history", HISTORY_MAX), ("exports", EXPORTS_MAX)):
        rows = raw.get(bucket)
        if not isinstance(rows, list):
            continue
        if rows:
            _append_many(bucket, rows, cap, skip_if_suffix=True)
        raw.pop(bucket)
        changed = True
    return changed


def check_id(value) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise BadId("Identificador inválido.")
    return value


def _replace(src: Path, dst: Path) -> None:
    # No Windows, antivírus/indexador segurando o arquivo dá PermissionError passageiro.
    for wait in (0.05, 0.1, 0.2, 0.2, None):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if wait is None:
                try:
                    os.remove(src)  # não deixa .tmp órfão
                except OSError:
                    pass
                raise
            time.sleep(wait)


def _write_file(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    _replace(tmp, path)


def atomic_write(path: Path, text: str) -> None:
    if path.exists():  # o .bak também é gravado de forma atômica, senão pode ficar pela metade
        _write_file(path.with_name(path.name + ".bak"), path.read_bytes())
    _write_file(path, text.encode("utf-8"))


def _read_safe(path: Path):
    """None só quando não há arquivo nenhum. Corrompido sem .bak válido levanta erro (nunca vazio em silêncio)."""
    bak = path.with_name(path.name + ".bak")
    if not path.exists() and not bak.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        try:
            text = bak.read_text(encoding="utf-8")
            doc = json.loads(text)
        except (OSError, ValueError):
            # o arquivo ruim fica no lugar: renomear faria a próxima leitura achar "vazio"
            raise ValueError("Arquivo de dados corrompido e sem cópia válida: %s" % path.name)
        if path.exists():
            path.rename(path.with_name("%s.corrompido-%d" % (path.name, int(time.time()))))
        # promove a cópia a principal: sem isso a 2ª leitura veria rev 0 e o .bak seria sobrescrito
        _write_file(path, text.encode("utf-8"))
        return doc


def load() -> dict:
    with LOCK:
        raw = _read_safe(data_dir() / "store.json") or {}
        if isinstance(raw, dict) and _migrate_logs(raw):
            _write(raw)  # .bak fica com as listas, para voltar atrás se o JSONL falhar
        if not isinstance(raw, dict):
            raw = {}
        base = empty()
        base.update({k: v for k, v in raw.items() if k in base})
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
        if not isinstance(patch, dict):
            raise ValueError("Alteração inválida: esperado um objeto.")
        for key in EDITABLE:
            # tipo errado aqui quebraria a página no próximo carregamento
            want = dict if key == "settings" else list
            if key in patch and not isinstance(patch[key], want):
                raise ValueError("Campo '%s' inválido: esperado %s." % (key, "objeto" if want is dict else "lista"))
        for key in EDITABLE:
            if key in patch:
                doc[key] = patch[key]
        doc["rev"] += 1
        _write(doc)
        return {"rev": doc["rev"]}


def log(kind: str, detail: dict | None = None, project: str = "") -> dict:
    detail = detail or {}
    if not isinstance(detail, (dict, str)):
        raise ValueError("Detalhe do registro inválido: esperado objeto ou texto.")
    if len(json.dumps(detail, ensure_ascii=False)) > DETAIL_MAX:
        raise ValueError("Detalhe do registro grande demais.")
    with LOCK:
        doc = load()
        entry = {"t": now(), "kind": str(kind)[:60], "project": str(project)[:64], "detail": detail}
        _append_many("history", [entry], HISTORY_MAX)
        if kind == "export":
            _append_many("exports", [entry], EXPORTS_MAX)
        return {"rev": doc["rev"]}  # o histórico não muda `rev`: ele só controla os dados editáveis


def read_history(offset: int = 0, limit: int = 50, bucket: str = "history") -> dict:
    """Página mais recente primeiro. limit fica entre 1 e 100; bucket só history ou exports."""
    if bucket not in ("history", "exports"):
        raise ValueError("Registro inválido.")
    if type(offset) is not int or offset < 0:
        raise ValueError("offset inválido.")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit inválido.")
    with LOCK:
        lines = _log_lines(_log_path(bucket))
    page = list(reversed(lines))[offset:offset + limit]
    items = []
    for line in page:
        try:
            items.append(json.loads(line))
        except ValueError:
            continue
    return {"total": len(lines), "offset": offset, "limit": limit, "items": items}


def load_project(pid: str) -> dict:
    check_id(pid)
    with LOCK:
        doc = _read_safe(data_dir() / ("project_%s.json" % pid))
        if doc is not None and not isinstance(doc, dict):
            raise ValueError("O arquivo do projeto não é um objeto JSON.")
        doc = doc or {"parts": [], "files": [], "uid": 0, "seq": {}, "groups": {}}
        doc.setdefault("rev", 0)  # arquivo antigo, sem revisão, conta como 0
        return doc


def delete_project(pid: str) -> str:
    """Tira o projeto de uso sem apagar: o arquivo vira project_<id>.json.excluido-<hora>, que nada lê
    nem serve, e pode ser renomeado de volta para recuperar. Devolve o nome novo ('' se não havia arquivo)."""
    check_id(pid)
    with LOCK:
        path = data_dir() / ("project_%s.json" % pid)
        if not path.exists():
            return ""
        dest = path.with_name("%s.excluido-%d" % (path.name, int(time.time())))
        _replace(path, dest)
        return dest.name


def save_project(pid: str, payload: dict) -> int:
    """Grava o projeto e devolve a nova revisão. Sem "rev" no payload, grava sem conferir (compatível)."""
    check_id(pid)
    if not isinstance(payload, dict):
        raise ValueError("Projeto inválido: esperado um objeto.")
    for key in ("parts", "files"):
        if key in payload and not isinstance(payload[key], list):
            raise ValueError("Campo '%s' do projeto inválido: esperado lista." % key)
    with LOCK:
        path = data_dir() / ("project_%s.json" % pid)
        current = (_read_safe(path) or {}).get("rev", 0)
        sent = payload.get("rev")
        if isinstance(sent, int) and not isinstance(sent, bool) and sent != current:
            raise Conflict("O projeto mudou em outra janela. Recarregue a página.")
        rev = (current if isinstance(current, int) else 0) + 1
        atomic_write(path, json.dumps({**payload, "rev": rev}, ensure_ascii=False))
        return rev


def snapshot(keep: int = 14) -> Path | None:
    """Cópia diária dos .json em backups/AAAA-MM-DD; guarda só as `keep` mais recentes."""
    with LOCK:
        root = data_dir() / "backups"
        day = root / time.strftime("%Y-%m-%d")
        if day.exists():
            return None
        tmp = root / (day.name + ".tmp")  # pasta parcial nunca fica com o nome do dia
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for pattern in ("*.json", "*.jsonl"):
            for src in data_dir().glob(pattern):
                shutil.copy2(src, tmp / src.name)
        tmp.rename(day)
        days = sorted(p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name))
        for old in days[:-keep] if keep > 0 else []:
            shutil.rmtree(old, ignore_errors=True)
        return day
