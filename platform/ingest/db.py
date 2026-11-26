"""Database helpers, import-run bookkeeping, retries and rate limiting."""
from __future__ import annotations

import contextlib
import hashlib
import os
import time
from pathlib import Path
from typing import Any, Callable, Iterator

import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    for name in (".env.local", ".env"):
        p = ROOT / name
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def connect(url: str | None = None) -> psycopg.Connection:
    load_env()
    url = url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set (copy .env.example to .env.local)")
    return psycopg.connect(url, autocommit=False)


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ImportRun:
    """Records one import in import_run. Counters are updated by the adapter."""

    def __init__(self, conn: psycopg.Connection, source_id: str, adapter: str, *, file_name: str | None = None,
                 file_sha256: str | None = None, source_vintage: str | None = None, params: dict | None = None,
                 is_demo: bool = False):
        self.conn = conn
        self.counts = {"rows_read": 0, "rows_inserted": 0, "rows_updated": 0, "rows_unchanged": 0, "rows_rejected": 0}
        self.logs: list[str] = []
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO import_run (source_id, adapter, file_name, file_sha256, source_vintage, params, is_demo)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                (source_id, adapter, file_name, file_sha256, source_vintage, Jsonb(params or {}), is_demo),
            )
            self.id = cur.fetchone()[0]
        conn.commit()

    def log(self, msg: str) -> None:
        self.logs.append(msg)

    def bump(self, key: str, n: int = 1) -> None:
        self.counts[key] += n

    def finish(self, status: str, error: str | None = None) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                """UPDATE import_run SET finished_at = now(), status = %s, error = %s, log = %s,
                     rows_read=%s, rows_inserted=%s, rows_updated=%s, rows_unchanged=%s, rows_rejected=%s
                   WHERE id = %s""",
                (status, error, self.logs[-500:], *self.counts.values(), self.id),
            )
        self.conn.commit()


@contextlib.contextmanager
def import_run(conn: psycopg.Connection, source_id: str, adapter: str, **kw: Any) -> Iterator[ImportRun]:
    run = ImportRun(conn, source_id, adapter, **kw)
    try:
        yield run
    except Exception as e:  # record failure, then re-raise
        conn.rollback()
        run.finish("failed", f"{type(e).__name__}: {e}")
        raise
    else:
        conn.commit()
        run.finish("partial" if run.counts["rows_rejected"] else "succeeded")


class RateLimiter:
    """Minimum interval between calls to one host (source-specific politeness)."""

    def __init__(self, min_interval_s: float):
        self.min_interval_s = min_interval_s
        self._last = 0.0

    def wait(self) -> None:
        delta = time.monotonic() - self._last
        if delta < self.min_interval_s:
            time.sleep(self.min_interval_s - delta)
        self._last = time.monotonic()


def with_retries(fn: Callable[[], Any], *, attempts: int = 4, base_delay_s: float = 2.0,
                 retry_on: tuple[type[BaseException], ...] = (Exception,), log: Callable[[str], None] | None = None) -> Any:
    """Exponential backoff: 2s, 4s, 8s ... Raises the last error."""
    for i in range(attempts):
        try:
            return fn()
        except retry_on as e:  # noqa: PERF203
            if i == attempts - 1:
                raise
            delay = base_delay_s * (2 ** i)
            if log:
                log(f"attempt {i + 1} failed ({type(e).__name__}: {e}); retrying in {delay:.0f}s")
            time.sleep(delay)


def record_exception(cur: psycopg.Cursor, entity_type: str, source_id: str, ref: str, issue: str, detail: str,
                     run_id: int | None, candidate_ids: list[int] | None = None, scores: list[float] | None = None) -> None:
    """Upsert into the exceptions queue; re-imports refresh detail but never reopen resolved items."""
    cur.execute(
        """INSERT INTO match_exception (entity_type, source_id, source_record_ref, issue, detail, candidate_ids, candidate_scores, import_run_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (entity_type, source_id, source_record_ref, issue)
           DO UPDATE SET detail = EXCLUDED.detail, candidate_ids = EXCLUDED.candidate_ids,
                         candidate_scores = EXCLUDED.candidate_scores, import_run_id = EXCLUDED.import_run_id""",
        (entity_type, source_id, ref, issue, detail, candidate_ids or [], scores or [], run_id),
    )
