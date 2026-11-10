"""Import-time derivation of the generated package's schema fingerprints.

``muse_code_msp`` commits no fingerprint literal; each module's
``SCHEMA_FINGERPRINT`` derives at import from schema bytes through the
stdlib-only port the package vendors (``muse_code_msp._fingerprint``,
whose algorithm section is byte-identical to the fingerprint script).
This suite proves the derivation three
ways: the vendored port proves the shared vectors, the tree's modules agree
with the script on the committed bundles, and fixture layouts prove each
resolution arm — a live tree at any depth, bundled wheel bytes, an
installed copy under a live tree reading its bundle, an installed copy
without a bundle falling through to the live tree, a source copy beside
an installed distribution reading the live tree, and a fail-closed
refusal with nowhere to read from.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = PROJECT_ROOT / "scripts" / "msp_fingerprint.py"
VENDORED = (
    PROJECT_ROOT / "clients" / "msp-py" / "src" / "muse_code_msp" / "_fingerprint.py"
)
MSP_SRC = PROJECT_ROOT / "clients" / "msp-py" / "src"

# Minimal fixture bundles: the resolver tests prove RESOLUTION (which bytes
# feed the algorithm), so their oracle is the script's own derivation over
# these bytes — never a hand-typed hash. The algorithm itself is pinned by
# the shared vectors, which the vendored port proves below.
FIXTURE_STABLE = (
    '{"$defs": {"Ping": {"type": "object", '
    '"properties": {"echo": {"type": "string"}}, "required": ["echo"]}}}'
)
FIXTURE_EXPERIMENTAL = (
    '{"$defs": {"Ping": {"type": "object", "properties": {}}, '
    '"Probe": {"type": "object", "properties": {}, '
    '"x-msp-stability": "experimental"}}}'
)


def _load_script() -> types.ModuleType:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
    try:
        import msp_fingerprint

        return msp_fingerprint
    finally:
        sys.path.pop(0)


def _load_fixture_port(source: Path, tag: str) -> types.ModuleType:
    # Import a COPY of the port (the script or the vendored module) from a
    # fixture layout under its own module name: the resolver anchors on
    # __file__, so the copy must live at the layout position it proves.
    # Unique names keep parallel tests from sharing one sys.modules entry.
    name = f"fixture_fingerprint_{tag}"
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
    # Every layout arm runs against both the script (the algorithm's source
    # of truth) and the vendored module the wheel ships: the regen gate
    # proves the vendored bytes equal the script, and these arms prove both
    # copies resolve the same way.
    origin = SCRIPT if request.param == "script" else VENDORED
    assert origin.is_file(), f"port source missing: {origin}"
    return origin


def _write_schema_bundle(root: Path) -> None:
    for variant, document in (
        ("stable", FIXTURE_STABLE),
        ("experimental", FIXTURE_EXPERIMENTAL),
    ):
        bundle_dir = root / "schema" / "msp" / variant
        bundle_dir.mkdir(parents=True)
        (bundle_dir / "msp.schema.json").write_text(document + "\n")


def _write_bundled_schema(package_dir: Path) -> None:
    for variant, document in (
        ("stable", FIXTURE_STABLE),
        ("experimental", FIXTURE_EXPERIMENTAL),
    ):
        bundled_dir = package_dir / "_schema" / variant
        bundled_dir.mkdir(parents=True)
        (bundled_dir / "msp.schema.json").write_text(document + "\n")


def _expected(port: types.ModuleType) -> dict[str, str]:
    return {
        "stable": port.bundle_fingerprint("stable", FIXTURE_STABLE),
        "experimental": port.bundle_fingerprint("experimental", FIXTURE_EXPERIMENTAL),
    }


def _assert_dist_resolves(port: types.ModuleType) -> None:
    # The distinguishing precondition both installed-arm pins share:
    # the dist-info fixture must be visible to importlib. When it is
    # invisible, derive falls through to the live tree for the wrong
    # reason and the arm proves nothing about its installed layout.
    try:
        importlib.metadata.distribution(port._DISTRIBUTION)
    except importlib.metadata.PackageNotFoundError:
        raise AssertionError(
            "the dist-info fixture must resolve or this arm is vacuous"
        ) from None


# The live tree as the schema looks AFTER the wheel was built: the bundle
# freezes the fixture documents above, the checkout has advanced past them.
# An installed copy under this tree must still read its frozen bundle.
LIVE_STABLE = (
    '{"$defs": {"Ping": {"type": "object", '
    '"properties": {"echo": {"type": "string"}, "n": {"type": "integer"}}, '
    '"required": ["echo", "n"]}}}'
)
LIVE_EXPERIMENTAL = (
    '{"$defs": {"Ping": {"type": "object", "properties": {}}, '
    '"Probe": {"type": "object", "properties": {}, '
    '"x-msp-stability": "experimental"}, '
    '"Extra": {"type": "object", "properties": {}}}}'
)


def _write_live_schema_bundle(root: Path) -> None:
    for variant, document in (
        ("stable", LIVE_STABLE),
        ("experimental", LIVE_EXPERIMENTAL),
    ):
        bundle_dir = root / "schema" / "msp" / variant
        bundle_dir.mkdir(parents=True)
        (bundle_dir / "msp.schema.json").write_text(document + "\n")


def test_the_vendored_port_proves_every_vector() -> None:
    # The SDK proof: the copy the package ships reproduces the shared
    # vectors — values and refusal vocabulary — with no derivation of its
    # own. (The twin relations belong to the script's suite; byte-identity
    # with the script is the regen gate's verdict.)
    sys.path.insert(0, str(MSP_SRC))
    try:
        from muse_code_msp import _fingerprint as vendored
    finally:
        sys.path.pop(0)
    fixture = json.loads(
        (PROJECT_ROOT / "schema" / "msp" / "fingerprint-vectors.json").read_text()
    )
    vectors = fixture["vectors"]
    assert vectors, "an empty vector file proves nothing"
    for vector in vectors:
        name = vector["name"]
        try:
            actual = vendored.bundle_fingerprint(vector["variant"], vector["schema"])
        except vendored.FingerprintError as error:
            assert error.kind == vector.get("error"), (
                f"vector `{name}` refused differently ({error})"
            )
        else:
            assert actual == vector.get("fingerprint"), (
                f"vector `{name}` moved (actual {actual})"
            )


def test_the_tree_modules_agree_with_the_script_on_the_committed_bundles() -> None:
    # The permanent live proof: the imported values equal the script's
    # derivation over the committed bundles, stable and experimental. The
    # wire value stays byte-identical; only its source moved (D1).
    sys.path.insert(0, str(MSP_SRC))
    try:
        import muse_code_msp
        import muse_code_msp.experimental
    finally:
        sys.path.pop(0)
    script = _load_script()
    for variant, module in (
        ("stable", muse_code_msp),
        ("experimental", muse_code_msp.experimental),
    ):
        schema_bytes = (
            PROJECT_ROOT / "schema" / "msp" / variant / "msp.schema.json"
        ).read_bytes()
        assert module.SCHEMA_FINGERPRINT == script.bundle_fingerprint(
            variant, schema_bytes
        ), f"the {variant} module disagrees with the script's derivation"


def test_bundled_bytes_serve_an_installed_layout(
    port_source: Path, tmp_path: Path
) -> None:
    # The wheel layout: no live tree above the package (a fresh tmp dir has
    # no schema/ ancestor), so the bundled copy is the only source.
    package_dir = tmp_path / "site" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_bundled_schema(package_dir)
    assert not list(tmp_path.glob("schema")), "the live tree must be absent here"
    port = _load_fixture_port(fixture_port, f"bundled_{port_source.stem}")
    try:
        expected = _expected(port)
        assert port.derive_bundle_fingerprint("stable") == expected["stable"]
        assert port.derive_bundle_fingerprint("experimental") == expected["experimental"]
    finally:
        sys.modules.pop(port.__name__, None)


def test_a_live_tree_serves_at_any_depth(
    port_source: Path, tmp_path: Path
) -> None:
    # The source-checkout layout, mirror-shaped: the package sits four
    # levels under python/ while the schema rides the verbatim sibling, so
    # the resolver must walk past python/ instead of assuming one depth.
    package_dir = (
        tmp_path / "python" / "clients" / "msp-py" / "src" / "muse_code_msp"
    )
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_schema_bundle(tmp_path)
    port = _load_fixture_port(fixture_port, f"nested_{port_source.stem}")
    try:
        expected = _expected(port)
        assert port.derive_bundle_fingerprint("stable") == expected["stable"]
        assert port.derive_bundle_fingerprint("experimental") == expected["experimental"]
    finally:
        sys.modules.pop(port.__name__, None)


def test_a_live_tree_wins_over_stale_bundled_bytes(
    port_source: Path, tmp_path: Path
) -> None:
    # Stale staging leftovers (a crashed publish build) must never shadow
    # the live tree: the bundled copy names another bundle, the live tree
    # wins.
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_schema_bundle(tmp_path)
    stale_dir = package_dir / "_schema" / "stable"
    stale_dir.mkdir(parents=True)
    (stale_dir / "msp.schema.json").write_text('{"$defs": {}}\n')
    port = _load_fixture_port(fixture_port, f"livefirst_{port_source.stem}")
    try:
        expected = _expected(port)
        assert port.derive_bundle_fingerprint("stable") == expected["stable"]
        stale_value = port.bundle_fingerprint("stable", '{"$defs": {}}')
        assert expected["stable"] != stale_value, (
            "the stale bundle must differ or this arm is vacuous"
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_an_installed_copy_under_a_live_tree_reads_its_bundle(
    port_source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The in-checkout install: a regular (non-editable) install whose
    # site directory sits under a live checkout that has advanced past
    # the bundled schema. The installed copy reads its frozen bundle —
    # the live tree serves source layouts only.
    site = tmp_path / "site"
    package_dir = site / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_bundled_schema(package_dir)
    dist_info = site / "muse_code_msp-0.1.dist-info"
    dist_info.mkdir()
    (dist_info / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: muse-code-msp\nVersion: 0.1\n"
    )
    (dist_info / "RECORD").write_text(
        "muse_code_msp/_fingerprint.py,,\n"
        "muse_code_msp/_schema/stable/msp.schema.json,,\n"
        "muse_code_msp/_schema/experimental/msp.schema.json,,\n"
        "muse_code_msp-0.1.dist-info/METADATA,,\n"
        "muse_code_msp-0.1.dist-info/RECORD,,\n"
    )
    _write_live_schema_bundle(tmp_path)
    live_stable = tmp_path / "schema" / "msp" / "stable" / "msp.schema.json"
    assert live_stable.is_file(), "the live tree must be reachable here"
    monkeypatch.syspath_prepend(str(site))
    importlib.invalidate_caches()
    port = _load_fixture_port(fixture_port, f"incheckout_{port_source.stem}")
    try:
        expected = _expected(port)
        live = {
            "stable": port.bundle_fingerprint("stable", LIVE_STABLE),
            "experimental": port.bundle_fingerprint(
                "experimental", LIVE_EXPERIMENTAL
            ),
        }
        assert expected != live, "the live tree must differ or this arm is vacuous"
        assert port.derive_bundle_fingerprint("stable") == expected["stable"]
        assert (
            port.derive_bundle_fingerprint("experimental")
            == expected["experimental"]
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_an_installed_copy_without_a_bundle_reads_the_live_tree(
    port_source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An installed copy that bundles nothing (an exotic installer, never
    # the publish path — verify_dist refuses bundle-less wheels) falls
    # through to the live tree instead of failing: the bundle arm only
    # takes what it can prove.
    site = tmp_path / "site"
    package_dir = site / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    dist_info = site / "muse_code_msp-0.1.dist-info"
    dist_info.mkdir()
    (dist_info / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: muse-code-msp\nVersion: 0.1\n"
    )
    _write_live_schema_bundle(tmp_path)
    monkeypatch.syspath_prepend(str(site))
    importlib.invalidate_caches()
    port = _load_fixture_port(fixture_port, f"nobundle_{port_source.stem}")
    try:
        _assert_dist_resolves(port)
        anchor = Path(port.__file__).resolve()
        assert port._this_copy_is_installed(anchor), (
            "this copy must count as installed or the fall-through "
            "proves nothing"
        )
        live = {
            "stable": port.bundle_fingerprint("stable", LIVE_STABLE),
            "experimental": port.bundle_fingerprint(
                "experimental", LIVE_EXPERIMENTAL
            ),
        }
        assert port.derive_bundle_fingerprint("stable") == live["stable"]
        assert (
            port.derive_bundle_fingerprint("experimental")
            == live["experimental"]
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_a_source_copy_beside_an_install_reads_the_live_tree(
    port_source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The editable-install shape: the distribution is visible to importlib
    # but the importing copy is a source file outside the installed
    # location, with a stale bundle beside it and an advanced live tree
    # above. Mere presence of the distribution must not flip the copy to
    # its stale bundle — the live tree wins.
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_bundled_schema(package_dir)
    site = tmp_path / "site"
    dist_info = site / "muse_code_msp-0.1.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: muse-code-msp\nVersion: 0.1\n"
    )
    _write_live_schema_bundle(tmp_path)
    monkeypatch.syspath_prepend(str(site))
    importlib.invalidate_caches()
    port = _load_fixture_port(fixture_port, f"outside_{port_source.stem}")
    try:
        _assert_dist_resolves(port)
        anchor = Path(port.__file__).resolve()
        assert not port._this_copy_is_installed(anchor), (
            "this copy must count as source or the live read proves nothing"
        )
        stale = _expected(port)
        live = {
            "stable": port.bundle_fingerprint("stable", LIVE_STABLE),
            "experimental": port.bundle_fingerprint(
                "experimental", LIVE_EXPERIMENTAL
            ),
        }
        assert stale != live, "the live tree must differ or this arm is vacuous"
        assert port.derive_bundle_fingerprint("stable") == live["stable"]
        assert (
            port.derive_bundle_fingerprint("experimental")
            == live["experimental"]
        )
    finally:
        sys.modules.pop(port.__name__, None)


def test_nowhere_to_read_from_fails_closed(
    port_source: Path, tmp_path: Path
) -> None:
    # Neither a live tree nor bundled bytes: a loud ImportError naming the
    # variant and both places it looked, never a guessed value.
    package_dir = tmp_path / "nowhere" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    port = _load_fixture_port(fixture_port, f"missing_{port_source.stem}")
    try:
        with pytest.raises(ImportError) as caught:
            port.derive_bundle_fingerprint("stable")
        message = str(caught.value)
        assert "stable" in message
        assert "msp.schema.json" in message
        assert "_schema" in message
    finally:
        sys.modules.pop(port.__name__, None)


def test_an_unknown_variant_fails_fast_not_as_a_missing_tree(
    port_source: Path, tmp_path: Path
) -> None:
    # A programmer error (unknown variant) must read as one — a ValueError
    # naming the variant — never as a missing schema tree.
    package_dir = tmp_path / "nowhere" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    port = _load_fixture_port(fixture_port, f"variant_{port_source.stem}")
    try:
        with pytest.raises(ValueError, match="bogus"):
            port.derive_bundle_fingerprint("bogus")
    finally:
        sys.modules.pop(port.__name__, None)


def test_the_live_tree_walk_is_bounded(port_source: Path, tmp_path: Path) -> None:
    # The walk gives up after its limit instead of climbing to the
    # filesystem root: a schema eleven levels up is not found, and the
    # refusal names the miss rather than hanging the import.
    deep = tmp_path
    for level in range(11):
        deep = deep / f"level{level}"
    package_dir = deep / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    _write_schema_bundle(tmp_path)
    port = _load_fixture_port(fixture_port, f"bounded_{port_source.stem}")
    try:
        with pytest.raises(ImportError):
            port.derive_bundle_fingerprint("stable")
    finally:
        sys.modules.pop(port.__name__, None)


def test_unparseable_live_bytes_refuse_with_the_vocabulary_word(
    port_source: Path, tmp_path: Path
) -> None:
    # The resolver feeds bytes through the one algorithm: corrupt live
    # bytes refuse with the fixture's word, never a traceback-only crash.
    package_dir = tmp_path / "clients" / "msp-py" / "src" / "muse_code_msp"
    package_dir.mkdir(parents=True)
    fixture_port = package_dir / "_fingerprint.py"
    fixture_port.write_bytes(port_source.read_bytes())
    bundle_dir = tmp_path / "schema" / "msp" / "stable"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "msp.schema.json").write_text("{not json\n")
    port = _load_fixture_port(fixture_port, f"corrupt_{port_source.stem}")
    try:
        with pytest.raises(port.FingerprintError) as caught:
            port.derive_bundle_fingerprint("stable")
        assert caught.value.kind == "unparseable-document"
    finally:
        sys.modules.pop(port.__name__, None)
