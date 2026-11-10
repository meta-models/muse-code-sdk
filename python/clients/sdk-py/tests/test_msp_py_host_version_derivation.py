"""Import-time derivation of the generated package's required host version.

``muse_code_msp`` commits no host-version literal; each module's
``REQUIRED_HOST_VERSION`` derives at import: the installed distribution
version first (wheels and editable installs read their own metadata),
falling back in-tree to the host crate's manifest beside the checkout.
This suite proves the derivation three ways: no literal
remains in either header, the tree's modules agree with the CLI manifest,
and fixture layouts prove each resolution arm — an installed
distribution, an in-tree manifest at any depth, and a fail-closed refusal
with nowhere to read from.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = PROJECT_ROOT / "scripts" / "msp_host_version.py"
VENDORED = (
    PROJECT_ROOT / "clients" / "msp-py" / "src" / "muse_code_msp" / "_host_version.py"
)
MSP_SRC = PROJECT_ROOT / "clients" / "msp-py" / "src"
HEADERS = (
    MSP_SRC / "muse_code_msp" / "__init__.py",
    MSP_SRC / "muse_code_msp" / "experimental" / "__init__.py",
)
DISTRIBUTION = "muse-code-msp"

# The stamped shape the renderer used to emit; its absence is the cutover.
_LITERAL = 'REQUIRED_HOST_VERSION: Final[str] = "'

# A distribution name no environment provides, so the fallback arms prove
# the in-tree read deterministically even where the real distribution is
# installed (editable CI installs would otherwise win by installed-first).
_MISSING_DISTRIBUTION = "muse-code-msp-missing-fixture"


def _load_fixture_port(source: Path, tag: str) -> types.ModuleType:
    # Import a COPY of the resolver (the script or the vendored module)
    # from a fixture layout under its own module name: the resolver
    # anchors on __file__, so the copy must live at the layout position
    # it proves. Unique names keep parallel tests from sharing one
    # sys.modules entry.
    name = f"fixture_host_version_{tag}"
    assert name not in sys.modules, f"fixture module name reused: {name}"
    spec = importlib.util.spec_from_file_location(name, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


@pytest.fixture(params=["script", "vendored"], ids=["script", "vendored"])
def port_source(request: pytest.FixtureRequest) -> Path:
    # Every layout arm runs against both the script (the resolver's
    # source of truth) and the vendored module the wheel ships: the regen
    # gate proves the vendored bytes equal the script, and these arms
    # prove both copies resolve the same way.
    origin = SCRIPT if request.param == "script" else VENDORED
    assert origin.is_file(), f"resolver source missing: {origin}"
    return origin


def _write_cli_manifest(root: Path, version: str) -> None:
    manifest_dir = root / "crates" / "cli"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "Cargo.toml").write_text(
        f'[package]\nname = "fixture-host"\nversion = "{version}"\n'
    )


def _write_dist_info(site: Path, name: str, version: str) -> None:
    # The dist-info dirname escapes runs of [-_.] to underscores (PEP 427);
    # dashes in the name portion never match at discovery.
    dist_info = site / f"{name.replace('-', '_')}-{version}.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    )


def _cli_manifest_version(manifest: Path) -> str:
    # The test oracle is the manifest itself, never a hand-typed version.
    in_package = False
    for line in manifest.read_text().splitlines():
        trimmed = line.strip()
        if trimmed.startswith("["):
            in_package = trimmed == "[package]"
            continue
        if in_package and trimmed.startswith("version"):
            parts = trimmed.split('"')
            if len(parts) > 1 and parts[1]:
                return parts[1]
    raise AssertionError(f"{manifest}: no [package] version found")


def test_no_committed_host_version_literal_remains() -> None:
    for header in HEADERS:
        assert header.is_file(), f"generated header missing: {header}"
        assert _LITERAL not in header.read_text(), (
            f"{header.parent.name}/__init__.py still commits a host-version literal"
        )


def test_tree_modules_agree_with_the_cli_manifest() -> None:
    # The permanent live proof: the imported values equal the CLI
    # manifest's version. The wire value stays byte-identical; only its
    # source moved (installed metadata, else the in-tree manifest).
    sys.path.insert(0, str(MSP_SRC))
    try:
        import muse_code_msp
        import muse_code_msp.experimental
    finally:
        sys.path.pop(0)
    expected = _cli_manifest_version(PROJECT_ROOT / "crates" / "cli" / "Cargo.toml")
    assert muse_code_msp.REQUIRED_HOST_VERSION == expected, (
        "the stable module disagrees with the CLI manifest"
    )
    assert muse_code_msp.experimental.REQUIRED_HOST_VERSION == expected, (
        "the experimental module disagrees with the CLI manifest"
    )


def test_installed_distribution_wins(
    port_source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The wheel layout: the distribution metadata wins by sys.path order,
    # even where a live tree is also present.
    site = tmp_path / "site"
    _write_dist_info(site, DISTRIBUTION, "9.9.9")
    package_dir = tmp_path / "pkg" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    monkeypatch.syspath_prepend(str(site))
    importlib.invalidate_caches()
    port = _load_fixture_port(fixture_port, f"installed_{port_source.stem}")
    try:
        assert port.derive_host_version() == "9.9.9"
    finally:
        sys.modules.pop(port.__name__, None)


def test_in_tree_fallback_reads_cli_manifest(
    port_source: Path, tmp_path: Path
) -> None:
    # No installed distribution: the checkout's CLI manifest answers.
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_cli_manifest(tmp_path, "7.7.7")
    port = _load_fixture_port(fixture_port, f"fallback_{port_source.stem}")
    try:
        assert (
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION) == "7.7.7"
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_in_tree_fallback_serves_at_any_depth(
    port_source: Path, tmp_path: Path
) -> None:
    # The mirror-shaped layout: the package sits four levels under
    # python/ while the manifest rides the verbatim tree, so the walk
    # must not assume one depth.
    package_dir = (
        tmp_path / "python" / "clients" / "msp-py" / "src" / "muse_code_msp"
    )
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_cli_manifest(tmp_path, "7.7.7")
    port = _load_fixture_port(fixture_port, f"nested_{port_source.stem}")
    try:
        assert (
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION) == "7.7.7"
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_nowhere_to_read_from_fails_closed(
    port_source: Path, tmp_path: Path
) -> None:
    # Neither an installed distribution nor a live tree: a loud
    # ImportError naming both places it looked, never a guessed value.
    package_dir = tmp_path / "nowhere" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    port = _load_fixture_port(fixture_port, f"missing_{port_source.stem}")
    try:
        with pytest.raises(ImportError) as caught:
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION)
        message = str(caught.value)
        assert _MISSING_DISTRIBUTION in message
        assert "Cargo.toml" in message
    finally:
        sys.modules.pop(port.__name__, None)


def test_the_in_tree_walk_is_bounded(port_source: Path, tmp_path: Path) -> None:
    # The walk gives up after its limit instead of climbing to the
    # filesystem root: a manifest eleven levels up is not found, and the
    # refusal names the miss rather than hanging the import.
    deep = tmp_path
    for level in range(11):
        deep = deep / f"level{level}"
    package_dir = deep / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_cli_manifest(tmp_path, "7.7.7")
    port = _load_fixture_port(fixture_port, f"bounded_{port_source.stem}")
    try:
        with pytest.raises(ImportError):
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION)
    finally:
        sys.modules.pop(port.__name__, None)


def test_malformed_manifest_fails_closed(
    port_source: Path, tmp_path: Path
) -> None:
    # A manifest with no [package] version refuses with the same
    # fail-closed ImportError, never a traceback-only crash.
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    manifest_dir = tmp_path / "crates" / "cli"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "Cargo.toml").write_text('[package]\nname = "fixture-host"\n')
    port = _load_fixture_port(fixture_port, f"malformed_{port_source.stem}")
    try:
        with pytest.raises(ImportError):
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION)
    finally:
        sys.modules.pop(port.__name__, None)


def test_undecodable_manifest_fails_closed(
    port_source: Path, tmp_path: Path
) -> None:
    # Bytes that are not text are a miss, not a crash: the read refuses
    # with the same fail-closed ImportError (UnicodeDecodeError is a
    # ValueError the scan absorbs).
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_host_version.py"
    fixture_port.write_bytes(port_source.read_bytes())
    manifest_dir = tmp_path / "crates" / "cli"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "Cargo.toml").write_bytes(b"\xff\xfe\x00not-text")
    port = _load_fixture_port(fixture_port, f"undecodable_{port_source.stem}")
    try:
        with pytest.raises(ImportError):
            port.derive_host_version(distribution=_MISSING_DISTRIBUTION)
    finally:
        sys.modules.pop(port.__name__, None)
