"""Python twins of the ``@muse-code/sdk-cookbook`` recipes (spec 638
FR-638-024 / T050, PY-TEST-021).

One twin per recipe the TypeScript cookbook manifest exports
(``clients/sdk-cookbook/src/manifest.ts``), same recipe ids, same docs
pages, executed in CI against the same release-built host and
``muse-conformance`` fixture host. The set is DISCOVERED from the TS
cookbook tree by the twin test, never pinned as a count.

This is a test-lane harness (like ``clients/sdk-quickstart-py``): it is
never installed or published, and it consumes only the shipped
``muse-code-sdk`` public surface. It shares the quickstart harness's kit
(``quickstart_journey.host`` / ``.segments``) the way the TS quickstart
consumes the TS cookbook's kit — one kit, two harnesses, mirrored direction.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The shared kit lives in the quickstart harness; neither harness is
# installed, so the import seam is a path, exactly like each harness's own
# tests/conftest.py plumbs. Kept here (the package's own doorstep) so
# `python -m cookbook_recipes` works without a wrapper script.
_QUICKSTART_SRC = Path(__file__).resolve().parents[3] / "sdk-quickstart-py" / "src"
if str(_QUICKSTART_SRC) not in sys.path:
    sys.path.insert(0, str(_QUICKSTART_SRC))
