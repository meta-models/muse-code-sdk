"""Test-path plumbing: make both packages importable without an install.

CI editable-installs the packages; local runs (and the required-path-free
loop in the README) work straight from the tree through this hook.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
for _src in (
    _PROJECT_ROOT / "clients" / "msp-py" / "src",
    _PROJECT_ROOT / "clients" / "sdk-py" / "src",
):
    if str(_src) not in sys.path:
        sys.path.insert(0, str(_src))
