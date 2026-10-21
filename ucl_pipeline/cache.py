"""Download source files once and reuse the local cache."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "ucl-pipeline/0.1 (dataset build; cached local copies)"


def cache_path(cache_dir: Path, url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
    name = url.rstrip("/").split("/")[-1] or "index"
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in name)
    return cache_dir / f"{digest}_{safe}"


def fetch(url: str, cache_dir: Path, *, refresh: bool = False, timeout: int = 60) -> tuple[int, bytes]:
    """Return (status, body). 404 and other HTTP errors return that status and empty body."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_path(cache_dir, url)
    meta = path.with_suffix(path.suffix + ".http")
    if path.exists() and meta.exists() and not refresh:
        status = int(meta.read_text(encoding="utf-8").strip() or "200")
        return status, path.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            status = getattr(response, "status", 200) or 200
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = b""
    path.write_bytes(body)
    meta.write_text(str(status), encoding="utf-8")
    return status, body


def fetch_json(url: str, cache_dir: Path, *, refresh: bool = False) -> tuple[int, object | None]:
    status, body = fetch(url, cache_dir, refresh=refresh)
    if status != 200 or not body:
        return status, None
    return status, json.loads(body.decode("utf-8"))
