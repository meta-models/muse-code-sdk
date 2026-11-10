#!/usr/bin/env python3
"""The per-wheel compatibility rows for the Python SDK publish path.

The compatibility contract's release-cut half: each published
wheel pairs with the host version and schema fingerprint it was built
against, on the docs site's compatibility page. This emits that pairing for
the CURRENT tree's wheels, derived — never hand-typed — from each value's
one source of truth:

* wheel filename and version: the package manifests (PEP 427 normalization
  of the manifest's own name and version);
* host version: the wire-types distribution's own static ``[project]``
  version — what an installed wheel derives at import for its generated
  ``muse_code_msp.REQUIRED_HOST_VERSION``;
* schema fingerprint: derived from ``schema/msp/stable/msp.schema.json``'s
  bytes at gate time — under the repo root, or under its verbatim sibling
  when the root is the publication mirror's ``python/`` tree (which
  carries no schema of its own) — through the shared ``msp_fingerprint``
  module, never read from a committed copy. The generated package derives
  the same value at import through the port it vendors; the rows prove the
  built wheel bundles the schema bytes they name (``verify_dist``), so a
  wheel that would derive a different value stops the publish instead of
  shipping a row that names the wrong schema.

``scripts/publish-sdk-pypi.sh`` runs this as a gate — with ``--dist`` it
also proves the wheels the build actually produced are exactly the wheels
the rows name — and the publish integration commit appends the emitted rows
to ``clients/sdk-py/published-wheels.json``, which the docs build renders.
Everything here must also run from the publication mirror's checkout, so it
reads only paths inside the source closure (scripts/sdk-source-closure.json).

Stdlib only; TOML needs Python 3.11+ (tomllib) or the dev lock's tomli.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import msp_fingerprint

PACKAGES = (
    # Wire types first: the facade's rows make no sense without them, and the
    # owner-run publish ships muse-code-msp first for the same reason.
    ("msp-py", "muse_code_msp"),
    ("sdk-py", "muse_code"),
)


class RowError(Exception):
    """A row could not be derived; the publish path must stop."""


def _load_toml(path: Path) -> dict[str, Any]:
    try:
        import tomllib
    except ModuleNotFoundError:
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ModuleNotFoundError as error:
            raise RowError(
                f"reading {path} needs tomllib (Python 3.11+) or the dev lock's tomli"
            ) from error
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _msp_release_version(repo_root: Path) -> str:
    # The row's hostVersion is the wire-types distribution's own release
    # version: an installed SDK derives REQUIRED_HOST_VERSION from its own
    # installed metadata, so the row names exactly what the wheel will
    # derive at import. Read from the static manifest field, never from the
    # generated module (which carries the derivation hook and no literal) —
    # and never imported (the mirror's publish environment must not need
    # the package importable; pydantic is not installed there). The
    # lockstep test binds this to the host manifest's version on every
    # ride, so the producing tree and the mirror derive the same row.
    project = _load_toml(repo_root / "clients" / "msp-py" / "pyproject.toml")["project"]
    version = project["version"]
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RowError(
            f"muse-code-msp version {version!r} is not plain X.Y.Z semver; "
            "the row's hostVersion must name the release exactly"
        )
    return version


def _stable_schema_bytes(repo_root: Path) -> bytes:
    # The stable bundle lives at the verbatim layout in the publication
    # mirror — the closure manifest scopes no schema path under python/ —
    # while the python publish resolves repo_root to the mirror's python/
    # tree. Probe the verbatim sibling when the rooted layout is absent;
    # the rooted layout wins wherever it exists.
    candidates = (
        repo_root / "schema" / "msp" / "stable" / "msp.schema.json",
        repo_root.parent / "schema" / "msp" / "stable" / "msp.schema.json",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.read_bytes()
    raise RowError(
        f"the stable-bundle schema is missing under {repo_root} "
        "(looked under the repo root and its verbatim sibling); "
        "a wheel must not ship without its schema fingerprint"
    )


def wheel_rows(repo_root: Path) -> dict[str, Any]:
    host_version = _msp_release_version(repo_root)
    try:
        fingerprint = msp_fingerprint.bundle_fingerprint(
            "stable", _stable_schema_bytes(repo_root)
        )
    except msp_fingerprint.FingerprintError as error:
        raise RowError(f"the stable schema refuses fingerprinting: {error}") from error
    rows = []
    for package_dir, import_name in PACKAGES:
        project = _load_toml(repo_root / "clients" / package_dir / "pyproject.toml")["project"]
        # Plain X.Y.Z only: setuptools normalizes anything else to PEP 440 in
        # the built wheel's filename (1.0.0-rc.1 -> 1.0.0rc1), so a suffixed
        # version would derive a row naming a wheel that never gets built —
        # refuse with the real reason instead of a confusing parity mismatch.
        if not re.fullmatch(r"\d+\.\d+\.\d+", project["version"]):
            raise RowError(
                f"{project['name']} version {project['version']!r} is not plain "
                "X.Y.Z semver; PEP 440 normalization would change the built "
                "wheel's filename — extend this derivation before publishing "
                "a pre-release"
            )
        # PEP 427: runs of [-_.] in the distribution name become one _.
        normalized = re.sub(r"[-_.]+", "_", project["name"])
        rows.append(
            {
                "distribution": project["name"],
                "importName": import_name,
                "version": project["version"],
                "wheel": f"{normalized}-{project['version']}-py3-none-any.whl",
                "requiresPython": project["requires-python"],
                "hostVersion": host_version,
                "schemaFingerprint": fingerprint,
            }
        )
    return {"schemaVersion": 1, "wheels": rows}


def _bundled_schema_bytes(archive: zipfile.ZipFile, wheel_name: str, variant: str) -> bytes:
    entry = f"muse_code_msp/_schema/{variant}/msp.schema.json"
    try:
        return archive.read(entry)
    except KeyError as error:
        raise RowError(
            f"{wheel_name} bundles no {variant} schema ({entry} missing); "
            "a wheel must not ship without its schema fingerprint"
        ) from error


def verify_dist(rows: dict[str, Any], dist_dir: Path) -> None:
    """The built artifacts are exactly the wheels the rows name.

    The rows are a claim about what ships; this makes the publish gate hold
    the claim against what the build actually produced, in both directions —
    a missing wheel and an unexpected one each stop the publish. It also
    holds the msp wheel's bundled schema bytes against the row: the wheel's
    import-time derivation reads that copy, so a wheel without it would
    fail closed on install, and a wheel with a stale copy would derive a
    value the row does not name.
    """
    expected = {row["wheel"] for row in rows["wheels"]}
    built = {path.name for path in dist_dir.rglob("*.whl")}
    if built != expected:
        raise RowError(
            f"built wheels {sorted(built)} do not match the derived rows "
            f"{sorted(expected)}; a wheel must not ship without its row"
        )
    msp_rows = [row for row in rows["wheels"] if row["importName"] == "muse_code_msp"]
    if len(msp_rows) != 1:
        raise RowError(
            f"expected exactly one muse_code_msp row, found {len(msp_rows)}; "
            "a wheel must not ship without its schema fingerprint"
        )
    row = msp_rows[0]
    wheels = list(dist_dir.rglob(row["wheel"]))
    if len(wheels) != 1:
        raise RowError(
            f"expected exactly one built {row['wheel']}, found {len(wheels)}"
        )
    with zipfile.ZipFile(wheels[0]) as archive:
        bundled_stable = _bundled_schema_bytes(archive, wheels[0].name, "stable")
        bundled_experimental = _bundled_schema_bytes(
            archive, wheels[0].name, "experimental"
        )
    try:
        derived = msp_fingerprint.bundle_fingerprint("stable", bundled_stable)
    except msp_fingerprint.FingerprintError as error:
        raise RowError(
            f"{wheels[0].name} bundles a stable schema that refuses "
            f"fingerprinting: {error}"
        ) from error
    if derived != row["schemaFingerprint"]:
        raise RowError(
            f"{wheels[0].name} bundles a stable schema deriving {derived} but "
            f"its row names {row['schemaFingerprint']}; restage and rebuild"
        )
    # The rows name no experimental value, but an installed experimental
    # import must still derive: the bundled copy has to fingerprint.
    try:
        msp_fingerprint.bundle_fingerprint("experimental", bundled_experimental)
    except msp_fingerprint.FingerprintError as error:
        raise RowError(
            f"{wheels[0].name} bundles an experimental schema that refuses "
            f"fingerprinting: {error}"
        ) from error


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument(
        "--dist",
        type=Path,
        default=None,
        help="a built dist tree to verify against the derived rows",
    )
    args = parser.parse_args(argv)
    repo_root = (args.repo_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        rows = wheel_rows(repo_root)
        if args.dist is not None:
            verify_dist(rows, args.dist)
    except RowError as error:
        print(f"sdk-py-wheel-rows: {error}", file=sys.stderr)
        return 1
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
