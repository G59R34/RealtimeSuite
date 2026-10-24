from __future__ import annotations

import json
from typing import Iterator

import psycopg

from .db import psycopg_dsn

CHANNEL = "suite_realtime"


def event_stream() -> Iterator[str]:
    """Yield server-sent events for every row change on the suite channel."""
    connection = psycopg.connect(psycopg_dsn(), autocommit=True)
    try:
        connection.execute(f"LISTEN {CHANNEL}")
        yield "retry: 3000\n\n"
        while True:
            for notify in connection.notifies(timeout=15, stop_after=100):
                payload = notify.payload
                try:
                    data = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                yield f"event: change\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
            yield ": keepalive\n\n"
    except GeneratorExit:
        raise
    finally:
        connection.close()
