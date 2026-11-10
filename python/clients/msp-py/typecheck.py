#!/usr/bin/env python3
"""Check source consumers against the package builder's static wire surface."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile


def main() -> int:
    source = Path(__file__).resolve().parent / "src/muse_code_msp"
    with tempfile.TemporaryDirectory(prefix="msp-py-typecheck-") as temporary:
        root = Path(temporary)
        built = root / "muse_code_msp"
        shutil.copytree(source, built)
        loader = source / "_entry_loader.py"
        if loader.is_file():
            runpy.run_path(str(loader))["write_static_modules"](source, built)
        environment = dict(os.environ)
        existing = environment.get("MYPYPATH")
        environment["MYPYPATH"] = str(root) + (os.pathsep + existing if existing else "")
        return subprocess.call(
            [sys.executable, "-m", "mypy", *sys.argv[1:], str(built)], env=environment
        )


if __name__ == "__main__":
    raise SystemExit(main())
