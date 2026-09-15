"""Test-path plumbing: make the journey package and both SDK packages
importable without an install — the ``clients/sdk-py/tests/conftest.py``
pattern (CI editable-installs the SDK packages; the journey harness is never
installed anywhere)."""

from __future__ import annotations

import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
for _src in (
    _PROJECT_ROOT / "clients" / "msp-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-quickstart-py" / "src",
):
    if str(_src) not in sys.path:
        sys.path.insert(0, str(_src))
