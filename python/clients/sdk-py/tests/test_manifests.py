"""PY-TEST-007 ``manifests_pin_and_deps`` (specs/638-muse-sdk-python).

FR-638-001/002/006: the two package manifests carry the chartered shape
(names, floor, wheel purity, license, ``py.typed``), the dependency posture
holds (zero runtime deps in ``muse_code_msp``; exactly one exact-pinned
pydantic in ``muse_code``; every dev tool exact-pinned in the committed
lock), and the schema-fingerprint pin binds to the stable bundle manifest so
a schema advance that forgets the Python SDK reds this lane (14990 FR-006
pattern).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10: tomllib is 3.11+
    import tomli as tomllib  # type: ignore[no-redef]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MSP_DIR = PROJECT_ROOT / "clients" / "msp-py"
SDK_DIR = PROJECT_ROOT / "clients" / "sdk-py"
EXACT_PIN = re.compile(r"^[A-Za-z0-9._-]+==\d+(\.\d+)+([a-z]+\d+)?(\s*;.*)?$")


def _pyproject(package_dir: Path) -> dict[str, Any]:
    with (package_dir / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)


def _import_generated() -> Any:
    sys.path.insert(0, str(MSP_DIR / "src"))
    try:
        import muse_code_msp
    finally:
        sys.path.pop(0)
    return muse_code_msp


def _import_facade() -> Any:
    sys.path.insert(0, str(SDK_DIR / "src"))
    try:
        import muse_code
    finally:
        sys.path.pop(0)
    return muse_code


def test_generated_package_manifest_shape() -> None:
    project = _pyproject(MSP_DIR)["project"]
    assert project["name"] == "muse-code-msp"
    assert project["requires-python"] == ">=3.10"
    assert project.get("dependencies", []) == [], (
        "muse_code_msp declares a runtime dependency; INV-638-03 grants none"
    )
    assert "license" in project
    assert (MSP_DIR / "src" / "muse_code_msp" / "py.typed").is_file()


def test_facade_package_manifest_shape() -> None:
    project = _pyproject(SDK_DIR)["project"]
    assert project["name"] == "muse-code-sdk"
    assert project["requires-python"] == ">=3.10"
    deps = project.get("dependencies", [])
    assert len(deps) == 1, (
        f"muse_code declares {len(deps)} runtime dependencies; the ADR 638 D2 "
        "grant is exactly one (pydantic, exact pin)"
    )
    assert re.fullmatch(r"pydantic==\d+(\.\d+)+", deps[0]), (
        f"the pydantic dependency must be an exact pin, got: {deps[0]!r}"
    )
    assert "license" in project
    assert (SDK_DIR / "src" / "muse_code" / "py.typed").is_file()


def test_fingerprint_pin_binds_to_the_stable_manifest() -> None:
    manifest = json.loads(
        (PROJECT_ROOT / "schema" / "msp" / "stable" / "manifest.json").read_text()
    )
    generated = _import_generated()
    facade = _import_facade()
    assert generated.SCHEMA_FINGERPRINT == manifest["fingerprint"], (
        "generated muse_code_msp is stale against the stable bundle; "
        "rerun scripts/gen-msp-py.sh"
    )
    assert facade.EXPECTED_SCHEMA_FINGERPRINT == manifest["fingerprint"], (
        "muse_code.EXPECTED_SCHEMA_FINGERPRINT is stale against the stable "
        "bundle manifest; re-pin it with the schema advance (FM-638-1)"
    )


def test_required_host_version_binds_to_the_host_crate() -> None:
    # FR-638-006: the mismatch error's "required host version" is
    # tree-derived — the renderer reads crates/cli/Cargo.toml at render time
    # and the regen gate keeps the constant honest; this arm pins the bind.
    manifest = (PROJECT_ROOT / "crates" / "cli" / "Cargo.toml").read_text()
    in_package = False
    crate_version = None
    for line in manifest.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if in_package and stripped.startswith("version"):
            crate_version = stripped.split('"')[1]
            break
    assert crate_version, "crates/cli/Cargo.toml lost its [package] version"
    generated = _import_generated()
    assert generated.REQUIRED_HOST_VERSION == crate_version, (
        "generated muse_code_msp is stale against the host crate version; "
        "rerun scripts/gen-msp-py.sh"
    )


def test_dev_lock_is_exact_pinned() -> None:
    lock = PROJECT_ROOT / "clients" / "py-dev-requirements.txt"
    assert lock.is_file(), "the committed dev lock is missing (FR-638-002)"
    lines = [
        line.strip()
        for line in lock.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert lines, "the dev lock pins nothing"
    for line in lines:
        assert EXACT_PIN.fullmatch(line), f"not an exact pin: {line!r}"
