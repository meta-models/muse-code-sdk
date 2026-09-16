"""PY-TEST-027 ``publish_shape_and_inert_gate`` (specs/638-muse-sdk-python).

FR-638-030: the two package manifests are publish-shaped — PyPI names,
import pairing, version source, license with shipped text, every outbound
link at the mirror — and the publish gates live in a script the mirror
workflow calls by path (``scripts/publish-sdk-pypi.sh``, the
``publish-sdk-npm.sh`` pattern), whose DEFAULT mode publishes nothing.

This file pins the PACKAGE SHAPE, not the decision to publish — the
``clients/sdk-ts/test/npm-publication.test.ts`` posture. The publish itself
is owner-run (ADR 638 D6), permitted by D-065 (ADR 29534 D1, amending the
13929 record D-014) at the lockstep host version (D-063, ADR 25304 D4); the
shape pins exist so the first owner-run publish cannot ship a silently
regressed package.
"""

from __future__ import annotations

import re
import subprocess
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
GATE_SCRIPT = PROJECT_ROOT / "scripts" / "publish-sdk-pypi.sh"

# The one public venue (ADR 21932 Amendment 1; ADR 638 D6 reuses it).
TARGET_REPO = "meta-models/muse-code-sdk"

# A wall, not a budget (#9293 house rule): the gate script's default mode
# builds two pure-Python distributions offline; a longer run is a hang.
GATE_WALL_SECONDS = 300

PACKAGES = {
    MSP_DIR: ("muse-code-msp", "muse_code_msp"),
    SDK_DIR: ("muse-code-sdk", "muse_code"),
}


def _pyproject(package_dir: Path) -> dict[str, Any]:
    with (package_dir / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_the_pypi_names_are_the_chartered_ones() -> None:
    for package_dir, (distribution, _) in PACKAGES.items():
        project = _pyproject(package_dir)["project"]
        assert project["name"] == distribution, (
            f"{package_dir.name}: the ADR 638 D6 charter names the PyPI "
            f"distributions muse-code-msp / muse-code-sdk, got {project['name']!r}"
        )


def test_the_import_names_pair_with_the_distributions() -> None:
    # D6 pairs each distribution with its import name; the src-layout package
    # directory IS the import name, so the pairing is derived, not restated.
    for package_dir, (_, import_name) in PACKAGES.items():
        data = _pyproject(package_dir)
        assert data["tool"]["setuptools"]["packages"]["find"]["where"] == ["src"]
        assert (package_dir / "src" / import_name / "__init__.py").is_file()
        assert (package_dir / "src" / import_name / "py.typed").is_file()


def _host_version() -> str:
    cli_toml = PROJECT_ROOT / "crates" / "cli" / "Cargo.toml"
    with cli_toml.open("rb") as fh:
        version = tomllib.load(fh)["package"]["version"]
    assert isinstance(version, str)
    return version


def test_the_version_source_is_the_static_manifest_field() -> None:
    for package_dir, (distribution, _) in PACKAGES.items():
        project = _pyproject(package_dir)["project"]
        # The wheel filename, the per-wheel compatibility row, and the publish
        # gate all read ONE version source: the static [project] field. A
        # `dynamic` version would let the built artifact disagree with what
        # every gate read from the tree.
        assert "version" not in project.get("dynamic", []), (
            f"{distribution}: the version must be the static [project] field, "
            "not a dynamic hook — the publish gates and the per-wheel row "
            "derive from the manifest"
        )
        version = project["version"]
        # Plain X.Y.Z, no PEP 440 suffix: setuptools normalizes a suffix in
        # the built wheel's filename (1.0.0-rc.1 -> 1.0.0rc1), which would
        # break the derived per-wheel row; the gate script and the row
        # derivation refuse the same shape.
        assert re.fullmatch(r"\d+\.\d+\.\d+", version), (
            f"{distribution}: version {version!r} is not plain X.Y.Z semver"
        )
        # Lockstep equality (D-063; ADR 25304 D4): the manifest version IS the
        # crates/cli version, set by the release train in the same commit —
        # derived from the tree, never a hand pin. The old 0.x ratchet is
        # gone WITH its meaning: the version no longer encodes publish
        # eligibility. Publication is permitted at exactly this lockstep
        # version (D-065, ADR 29534 D1) — never a train-external one — so
        # the equality here is what the published wheel's version claims.
        assert version == _host_version(), (
            f"{distribution}: version {version!r} != crates/cli "
            f"{_host_version()!r} (D-063 lockstep, ADR 25304 D4: only the "
            "release train moves these versions, in one commit)"
        )


def test_the_license_is_mit_with_shipped_text() -> None:
    for package_dir, (distribution, _) in PACKAGES.items():
        project = _pyproject(package_dir)["project"]
        # FR-638-001: LICENSE metadata matching the TS packages' posture —
        # `license: MIT` in the manifest, the text shipped in the artifact.
        # PEP 639 spells that as an SPDX expression plus license-files; the
        # wheel then carries dist-info/licenses/LICENSE, which the gate
        # script's tarball audit requires.
        assert project["license"] == "MIT", (
            f"{distribution}: license must be the SPDX expression 'MIT' "
            f"(FR-638-001, TS posture), got {project.get('license')!r}"
        )
        assert project["license-files"] == ["LICENSE"], (
            f"{distribution}: MIT requires shipping the text; license-files "
            "must name the package's own LICENSE (a repo-root copy does not "
            "reach the wheel)"
        )
        assert (package_dir / "LICENSE").is_file()


def test_every_outbound_link_points_at_the_mirror() -> None:
    for package_dir, (distribution, _) in PACKAGES.items():
        raw = (package_dir / "pyproject.toml").read_text()
        project = _pyproject(package_dir)["project"]
        urls = project["urls"]
        assert urls["Homepage"] == f"https://github.com/{TARGET_REPO}"
        assert urls["Repository"] == f"https://github.com/{TARGET_REPO}"
        assert urls["Issues"] == f"https://github.com/{TARGET_REPO}/issues", (
            f"{distribution}: PyPI renders this as the project's issues link; "
            "pointed anywhere else it 404s for every reader"
        )
        # Sweep the WHOLE manifest, not a list of fields someone has to
        # remember to extend (the npm-publication test's bugs.url lesson).
        # Nothing legitimate in a published manifest names this private
        # repository, so any occurrence anywhere is the defect.
        assert "mslsrc/tbh" not in raw, (
            f"{distribution}: an installed package must not advertise this "
            "private repository anywhere in its manifest"
        )


def test_the_classifiers_state_the_posture() -> None:
    for package_dir, (distribution, _) in PACKAGES.items():
        project = _pyproject(package_dir)["project"]
        classifiers = project.get("classifiers", [])
        assert "Typing :: Typed" in classifiers, (
            f"{distribution}: py.typed ships in the wheel (FR-638-001); the "
            "registry-facing claim is this classifier"
        )
        status = [c for c in classifiers if c.startswith("Development Status ::")]
        assert status == ["Development Status :: 3 - Alpha"], (
            f"{distribution}: the withheld stability promise (D-013, untouched "
            f"by the D-065 publication carve) admits exactly the Alpha status, "
            f"got {status!r}"
        )


def test_the_wire_types_stay_out_of_the_facade_dependencies() -> None:
    # INV-638-03's letter: exactly one runtime dependency (the pydantic pin);
    # any second, for either package, is an owner escalation. muse-code-msp is
    # therefore deliberately NOT declared, the @muse-code/msp devDependency
    # precedent: it does not exist on the registry, and declaring it before it
    # does would turn a working editable install into a hard `pip install`
    # failure. The gate script's printed owner-run sequence publishes
    # muse-code-msp FIRST; promoting it into dependencies at that point is the
    # owner escalation INV-638-03 names, decided with the publish itself.
    deps = _pyproject(SDK_DIR)["project"].get("dependencies", [])
    assert all(not d.startswith("muse-code-msp") for d in deps)
    assert _pyproject(MSP_DIR)["project"].get("dependencies", []) == []


def _run_gate(
    *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    # The env is built from scratch — GITHUB_ACTIONS and the OIDC variables
    # are absent unless a test passes them — so the refusal arms below see
    # exactly the context they assert, wherever the suite itself runs.
    return subprocess.run(
        [str(GATE_SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=GATE_WALL_SECONDS,
        check=False,
        cwd=PROJECT_ROOT,
        env={
            "PATH": str(Path(sys.executable).parent) + ":/usr/bin:/bin",
            # The interpreter that carries the dev lock (build, setuptools);
            # the script's own test seam, defaulting to python3 on PATH.
            "SDK_PY_PYTHON": sys.executable,
            **(env or {}),
        },
    )


def test_the_gate_script_default_publishes_nothing() -> None:
    # The inert-gate arm: the DEFAULT invocation runs every gate, builds both
    # distributions offline, audits the wheels, emits the per-wheel rows, and
    # exits 0 having published nothing — there is no way to publish by
    # forgetting an argument (FR-638-030, the publish-sdk-npm.sh pattern).
    result = _run_gate()
    assert result.returncode == 0, (
        f"the default (build-only) mode must pass on the committed tree:\n"
        f"{result.stdout}\n{result.stderr}"
    )
    assert "NOTHING was published" in result.stdout
    # The positive anchor for the refusal arms' negative pins: build-only
    # mode reaches the tree-anchor gate, so its label exists under exactly
    # this name — renaming it in the script reds HERE, keeping the
    # "gate: tree anchor not in stdout" pins from going vacuous.
    assert "gate: tree anchor" in result.stdout
    # The default mode prints exactly what the owner would run (ADR 638 D6:
    # the publish act is owner-run); both distributions ship or neither does,
    # wire types first.
    assert "muse-code-msp" in result.stdout
    assert "muse-code-sdk" in result.stdout
    assert result.stdout.index("muse-code-msp") < result.stdout.index("muse-code-sdk")


def test_the_publish_mode_refuses_outside_the_mirror_workflow() -> None:
    # --publish exists so the mirror workflow has one path to call. D-065
    # (ADR 29534 D1, amending D-014) permits the publish, but trusted
    # publishing runs only inside the mirror's publish-pypi.yml: outside it
    # there is no OIDC exchange and no manual-token path, by design. Run
    # from anywhere else — _run_gate builds an env without GITHUB_ACTIONS —
    # the script must refuse FIRST, before even the tooling preflight (so
    # the refusal names the governing constraint, machine-state- and
    # tree-state-independently, without running two package builds), loudly
    # and publishing nothing (the FM posture, not a silent skip). The
    # ordering is keyed on BEHAVIOR, not a gate label: the interpreter
    # below cannot run, so the preflight, the builds, and every later gate
    # would each fail with its own message if any of them fired first — the
    # governing refusal being the one failure proves the gate ran first.
    result = _run_gate(
        "--publish", env={"SDK_PY_PYTHON": "/nonexistent-python-interpreter"}
    )
    assert result.returncode != 0, (
        "--publish must refuse outside the mirror's publish-pypi.yml"
    )
    assert "runs only inside the mirror's publish-pypi.yml" in result.stderr
    assert "Nothing was published" in result.stderr
    assert "/nonexistent-python-interpreter" not in result.stderr, (
        "the tooling preflight ran before the trusted-publishing gate"
    )
    # And the label-keyed pin for the other direction: a refused --publish
    # never reaches the tree-anchor gate (the label's existence is anchored
    # positively in test_the_gate_script_default_publishes_nothing).
    assert "gate: tree anchor" not in result.stdout


def test_the_publish_mode_refuses_without_the_oidc_permission() -> None:
    # The second fail-closed arm: inside Actions but the calling workflow
    # forgot `permissions: id-token: write`, so there is no OIDC token to
    # exchange. This refusal is what saves the first owner-run publish if
    # the mirror workflow ever loses the permission; the TS sibling
    # (clients/sdk-ts/test/publish-script.test.ts) pins the same arm.
    # The same behavior-keyed ordering seam as the arm above: the broken
    # interpreter makes every later check fail loudly, so the OIDC refusal
    # being the one failure proves this gate fired before the preflight.
    result = _run_gate(
        "--publish",
        env={
            "GITHUB_ACTIONS": "true",
            "SDK_PY_PYTHON": "/nonexistent-python-interpreter",
        },
    )
    assert result.returncode != 0, (
        "--publish must refuse inside Actions when no OIDC token is available"
    )
    assert "id-token: write" in result.stderr
    assert "Nothing was published" in result.stderr
    assert "/nonexistent-python-interpreter" not in result.stderr, (
        "the tooling preflight ran before the trusted-publishing gate"
    )
    assert "gate: tree anchor" not in result.stdout


def test_the_publish_path_cannot_ship_a_wheel_without_its_row(tmp_path: Path) -> None:
    # FR-638-028's release-cut half rides the publish path: the gate script
    # generates the per-wheel compatibility rows (scripts/sdk-py-wheel-rows.py)
    # as a GATE, so the first published wheel cannot ship without the row the
    # compatibility page adds with the release. Two halves: the wiring (the
    # gate script invokes the generator) and the refusal itself, PROVEN under
    # its fault — a dist tree whose wheels do not match the derived rows must
    # fail closed, not report success (the review's neutered-branch finding).
    script = GATE_SCRIPT.read_text()
    assert "sdk-py-wheel-rows.py" in script, (
        "the publish gate script no longer generates the per-wheel "
        "compatibility rows; the first published wheel would ship without "
        "its row (FR-638-028)"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "scripts" / "sdk-py-wheel-rows.py"),
            "--repo-root",
            str(PROJECT_ROOT),
            "--dist",
            str(tmp_path),  # empty: no built wheel matches any derived row
        ],
        capture_output=True,
        text=True,
        # A wall, not a budget: the derivation is a sub-second manifest read.
        timeout=120,
        check=False,
    )
    assert result.returncode != 0, (
        "an empty dist tree matched the derived rows; the wheel/row parity "
        "gate is not refusing (FR-638-028)"
    )
    assert "do not match the derived rows" in result.stderr


def test_a_pre_release_version_refuses_the_row_derivation(tmp_path: Path) -> None:
    # The plain-X.Y.Z refusal, proven under its fault: setuptools would
    # normalize a PEP 440 suffix in the built wheel's filename, so the
    # derivation must refuse a suffixed version with the real reason — not
    # let the first pre-release bump surface as a confusing parity mismatch.
    # The real tree can never carry this shape (the version pin above), so
    # the fault is seeded into a copied fixture of exactly the files the
    # script reads.
    for source in (
        "clients/msp-py/pyproject.toml",
        "clients/msp-py/src/muse_code_msp/__init__.py",
        "clients/sdk-py/pyproject.toml",
        "schema/msp/stable/manifest.json",
    ):
        target = tmp_path / source
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text((PROJECT_ROOT / source).read_text())
    manifest = tmp_path / "clients" / "sdk-py" / "pyproject.toml"
    # Version-agnostic seed: a literal replace would silently no-op after any
    # routine version bump, leaving the fixture unseeded and this arm redding
    # on a phantom guard regression.
    seeded, count = re.subn(
        r'(?m)^version = "[^"]+"$', 'version = "1.0.0-rc.1"', manifest.read_text()
    )
    assert count == 1, "fault seed found no version line in the fixture"
    manifest.write_text(seeded)
    result = subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "scripts" / "sdk-py-wheel-rows.py"),
            "--repo-root",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        # A wall, not a budget: the derivation is a sub-second manifest read.
        timeout=120,
        check=False,
    )
    assert result.returncode != 0, (
        "a pre-release version derived a row; PEP 440 normalization would "
        "rename the built wheel out from under it"
    )
    assert "extend this derivation before publishing a pre-release" in result.stderr
