"""``python -m memory_system`` — the host bridge (see :mod:`memory_system.bridge`).

Usage from a host process::

    python -m memory_system --serve                 # newline-delimited JSON
    python -m memory_system status '{"cwd": "..."}' # one-shot
    python -m memory_system --list                  # discover commands

stdout carries only the protocol; anything else (warnings from optional
dependencies such as ``jieba``) is redirected to stderr so a host parser can
read every line as JSON.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    # Never touch sys.stdout here. The bridge resolves the protocol stream once
    # at import time, and an ``assert`` about redirects left behind (common in
    # interpreters that were re-run) is not worth the fragility of swapping
    # global state around an import. Optional dependencies that print warnings
    # are silenced with ``-W ignore`` by the host, which owns the command line.
    from .bridge import run_cli

    code = run_cli(args)
    return code


if __name__ == "__main__":  # pragma: no cover - exercised via subprocess tests
    raise SystemExit(main())