"""PY-the governing rule ``mypy_strict_and_py_typed``.

The governing rule / the governing decision: ``mypy --strict`` green and ``py.typed``
shipped are GATES, not workflow decoration. Three properties, each an arm:

* the exact check the CI workflow runs (``mypy --strict`` over both source
  trees) passes, bound here so the pytest suite itself enforces it even if a
  workflow edit ever dropped the step;
* both manifests ship the ``py.typed`` marker in their wheel package-data —
  PY-the governing rule pins the marker FILE, but a wheel that omits it from
  package-data silently strips typing from every installed consumer;
* the public surface is strictly CONSUMABLE: a fully annotated consumer
  program type-checks under ``--strict`` against both packages, and a
  mis-typed consumer fails with a real type error (never a
  missing-``py.typed``/stub complaint, which would mean the types were
  never consulted at all).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10: tomllib is 3.11+
    import tomli as tomllib  # type: ignore[no-redef]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MSP_SRC = PROJECT_ROOT / "clients" / "msp-py" / "src"
SDK_SRC = PROJECT_ROOT / "clients" / "sdk-py" / "src"

# A wall, not a budget: mypy over these trees finishes in seconds; a longer
# run is a hung child that is never coming back (deadlock cap only).
MYPY_WALL_SECONDS = 300


def _run_mypy(args: list[str], cwd: Path, cache_dir: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    # Per-test cache dir and cwd: two tests (or two workers) sharing one
    # .mypy_cache race each other; isolation is the repo's test rule.
    command = [
        sys.executable,
        "-m",
        "mypy",
        "--strict",
        "--no-error-summary",
        "--cache-dir",
        str(cache_dir),
        *args,
    ]
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=MYPY_WALL_SECONDS,
        check=False,
    )


def test_mypy_strict_is_green_over_both_source_trees(tmp_path: Path) -> None:
    """The CI gate itself: ``mypy --strict`` over both packages' src trees."""
    result = _run_mypy([str(MSP_SRC), str(SDK_SRC)], cwd=tmp_path, cache_dir=tmp_path / "cache")
    assert result.returncode == 0, (
        "mypy --strict reds over the shipped source trees:\n"
        f"{result.stdout}{result.stderr}"
    )


def _package_data(package_dir: Path) -> dict[str, Any]:
    with (package_dir / "pyproject.toml").open("rb") as f:
        manifest = tomllib.load(f)
    data = manifest.get("tool", {}).get("setuptools", {}).get("package-data", {})
    assert isinstance(data, dict)
    return data


@pytest.mark.parametrize(
    ("package_dir", "import_name"),
    [
        (PROJECT_ROOT / "clients" / "msp-py", "muse_code_msp"),
        (PROJECT_ROOT / "clients" / "sdk-py", "muse_code"),
    ],
    ids=["muse_code_msp", "muse_code"],
)
def test_py_typed_ships_in_the_wheel_package_data(package_dir: Path, import_name: str) -> None:
    """The marker must reach the WHEEL: package-data, not just the src tree.

    PY-the governing rule already pins the marker file's existence; without this
    package-data entry setuptools builds a wheel with no ``py.typed`` and
    every installed consumer silently loses the types (PEP 561).
    """
    data = _package_data(package_dir)
    assert "py.typed" in data.get(import_name, []), (
        f"{package_dir.name}/pyproject.toml does not ship py.typed in "
        f"[tool.setuptools.package-data] for {import_name}; installed "
        "consumers would get no types"
    )


# The consumer programs resolve both packages as sources via MYPYPATH (a PEP
# 660 editable install is invisible to mypy, so site-packages discovery
# cannot carry this arm); the wheel-side py.typed half is the package-data
# arm above. --follow-imports=silent keeps this arm about the CONSUMER: the
# source trees' own strictness is the first arm's verdict.
_CONSUMER_ENV = {
    "MYPYPATH": f"{SDK_SRC}:{MSP_SRC}",
}

_WELL_TYPED_CONSUMER = '''\
"""A fully annotated consumer of the public surface, strict-mode clean."""

from __future__ import annotations

from typing import Final

import muse_code
import muse_code_msp

PIN: Final[str] = muse_code.EXPECTED_SCHEMA_FINGERPRINT


def fingerprints_agree() -> bool:
    return PIN == muse_code_msp.SCHEMA_FINGERPRINT


def fresh_fold() -> muse_code.SessionFold:
    return muse_code.SessionFold()


def fresh_pending() -> muse_code.PendingCommandSet[str]:
    return muse_code.PendingCommandSet[str]()
'''

_MISTYPED_CONSUMER = '''\
"""A consumer misusing the surface: strict mypy must red on [assignment]."""

from __future__ import annotations

import muse_code

wrong: int = muse_code.EXPECTED_SCHEMA_FINGERPRINT
'''


def _consumer_env() -> dict[str, str]:
    import os

    env = dict(os.environ)
    env.update(_CONSUMER_ENV)
    return env


def test_a_strict_consumer_type_checks_against_the_public_surface(tmp_path: Path) -> None:
    program = tmp_path / "consumer.py"
    program.write_text(_WELL_TYPED_CONSUMER)
    result = _run_mypy(
        ["--follow-imports=silent", str(program)],
        cwd=tmp_path,
        cache_dir=tmp_path / "cache",
        env=_consumer_env(),
    )
    assert result.returncode == 0, (
        "a fully annotated consumer fails mypy --strict against the public "
        f"surface:\n{result.stdout}{result.stderr}"
    )


def test_a_mistyped_consumer_reds_with_a_real_type_error(tmp_path: Path) -> None:
    program = tmp_path / "consumer.py"
    program.write_text(_MISTYPED_CONSUMER)
    result = _run_mypy(
        ["--follow-imports=silent", str(program)],
        cwd=tmp_path,
        cache_dir=tmp_path / "cache",
        env=_consumer_env(),
    )
    output = f"{result.stdout}{result.stderr}"
    assert result.returncode != 0, (
        "mypy --strict accepted a str-to-int assignment; the exported types "
        "were never consulted"
    )
    assert "[assignment]" in output, f"expected a real [assignment] error, got:\n{output}"
    # The failure must come from the TYPES, not from mypy failing to see
    # them: a missing-py.typed/stub complaint here would vacuously "red".
    assert "py.typed" not in output and "stubs" not in output, (
        f"mypy could not resolve the packages' types at all:\n{output}"
    )
