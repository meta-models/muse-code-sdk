"""Test-path plumbing: make the cookbook package, the quickstart kit it
shares, and both SDK packages importable without an install — the
``clients/sdk-quickstart-py/tests/conftest.py`` pattern (CI editable-installs
the SDK packages; the harnesses are never installed anywhere)."""

from __future__ import annotations

import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
for _src in (
    _PROJECT_ROOT / "clients" / "msp-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-quickstart-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-cookbook-py" / "src",
):
    if str(_src) not in sys.path:
        sys.path.insert(0, str(_src))
