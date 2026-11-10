"""The charter test ``manifests_pin_and_deps``.

The governing rule: the two package manifests carry the chartered shape
(names, floor, wheel purity, license, ``py.typed``), the dependency posture
holds (zero runtime deps in ``muse_code_msp``; exactly one exact-pinned
pydantic plus ``muse-code-msp`` at the facade's own version in ``muse_code``; every dev tool exact-pinned in the committed
lock), and the import-derived schema fingerprints agree with the values
derived from the bundles' schema bytes, so a drift between the port the
package vendors and the shared derivation reds this lane.
"""

from __future__ import annotations

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
        "muse_code_msp declares a runtime dependency; the governing rule grants none"
    )
    assert "license" in project
    assert (MSP_DIR / "src" / "muse_code_msp" / "py.typed").is_file()


def test_facade_package_manifest_shape() -> None:
    project = _pyproject(SDK_DIR)["project"]
    assert project["name"] == "muse-code-sdk"
    assert project["requires-python"] == ">=3.10"
    deps = project.get("dependencies", [])
    assert len(deps) == 2, (
        f"muse_code declares {len(deps)} runtime dependencies; the ruled "
        "grant is exactly two: pydantic (exact pin) and the companion "
        "wire-types package at the facade's own version"
    )
    assert re.fullmatch(r"pydantic==\d+(\.\d+)+", deps[0]), (
        f"the pydantic dependency must be an exact pin, got: {deps[0]!r}"
    )
    assert deps[1] == f"muse-code-msp=={project['version']}", (
        f"the wire-types dependency must be pinned to the facade's own version, got: {deps[1]!r}"
    )
    assert "license" in project
    assert (SDK_DIR / "src" / "muse_code" / "py.typed").is_file()


def _derived_fingerprint(variant: str) -> str:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
    try:
        import msp_fingerprint
    finally:
        sys.path.pop(0)
    schema_bytes = (
        PROJECT_ROOT / "schema" / "msp" / variant / "msp.schema.json"
    ).read_bytes()
    return msp_fingerprint.bundle_fingerprint(variant, schema_bytes)


def test_import_derived_fingerprints_agree_with_the_derivation() -> None:
    # Nothing is stamped: each generated module derives at import through
    # the vendored port, and the facade reuses the stable value. A drift
    # between the vendored copy and the shared derivation fails here.
    generated = _import_generated()
    facade = _import_facade()
    sys.path.insert(0, str(MSP_DIR / "src"))
    try:
        import muse_code_msp.experimental
    finally:
        sys.path.pop(0)
    expected_stable = _derived_fingerprint("stable")
    assert generated.SCHEMA_FINGERPRINT == expected_stable, (
        "generated muse_code_msp disagrees with the stable derivation; "
        "rerun scripts/gen-msp-py.sh"
    )
    assert facade.EXPECTED_SCHEMA_FINGERPRINT == expected_stable, (
        "muse_code.EXPECTED_SCHEMA_FINGERPRINT is not the generated stable value"
    )
    assert muse_code_msp.experimental.SCHEMA_FINGERPRINT == _derived_fingerprint(
        "experimental"
    ), (
        "generated muse_code_msp.experimental disagrees with the "
        "experimental derivation; rerun scripts/gen-msp-py.sh"
    )


def test_required_host_version_binds_to_the_host_crate() -> None:
    # The rule: the mismatch error's "required host version" is
    # tree-derived — the renderer reads the host source at render time
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
    assert crate_version, "the host source lost its [package] version"
    generated = _import_generated()
    assert generated.REQUIRED_HOST_VERSION == crate_version, (
        "generated muse_code_msp is stale against the host crate version; "
        "rerun scripts/gen-msp-py.sh"
    )


def test_dev_lock_is_exact_pinned() -> None:
    lock = PROJECT_ROOT / "clients" / "py-dev-requirements.txt"
    assert lock.is_file(), "the committed dev lock is missing"
    lines = [
        line.strip()
        for line in lock.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert lines, "the dev lock pins nothing"
    for line in lines:
        assert EXACT_PIN.fullmatch(line), f"not an exact pin: {line!r}"
