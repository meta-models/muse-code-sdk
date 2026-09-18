"""Run the cookbook recipes — ``python -m cookbook_recipes [--only <id>]``.

The harness half of the governing rule: reads ``MUSE_BIN`` / ``MUSE_CONFORMANCE_BIN``
itself and passes explicit paths down. Exit 0 only when every selected
recipe's journey is OK.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from .manifest import RECIPES
from .runner import RecipeHosts, format_cookbook_report, run_recipes, select_recipes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default=None, help="run one recipe by id")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[4]
    hosts = RecipeHosts(
        transcript_root=str(repo_root / "schema" / "msp" / "transcripts"),
        muse_bin=os.environ.get("MUSE_BIN") or None,
        conformance_bin=os.environ.get("MUSE_CONFORMANCE_BIN") or None,
    )
    selected = select_recipes(RECIPES, args.only)
    report = asyncio.run(run_recipes(selected, hosts))
    print(format_cookbook_report(report))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
