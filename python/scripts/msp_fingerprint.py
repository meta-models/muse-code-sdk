#!/usr/bin/env python3
"""The MSP schema fingerprint, in stdlib-only Python.

The fingerprint derives from the schema document's bytes through one
normalization: strip the experimental surface for the stable variant,
collapse single-branch string enums, sort keys, hash the preimage under a
domain tag. This module is the Python implementation of that
normalization, for tooling that must compute the value without the
compiled protocol crate — the per-wheel rows and the receipt-pin mirror
both import it — and for the generated wire-types package, which vendors
these bytes verbatim and derives each module's fingerprint at import, so
no committed copy remains to drift.

Conformance is proven, not eyeballed: the vector suite runs this module
against the shared fixture the compiled implementation proves as well
(the ``fingerprint-vectors`` fixture and its ``test_fingerprint_vectors``
suite). A port that cannot reproduce a vector fails its suite.

Error vocabulary (matches the fixture's `error` member):
  unparseable-document, dangling-reference, emptied-enum,
  unencodable-preimage.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

NORMALIZATION_VERSION = 1
DOMAIN = "muse.msp.schema-bundle"
STABILITY_KEY = "x-msp-stability"
EXPERIMENTAL_WORD = "experimental"
OPENNESS_KEY = "x-msp-openness"


class FingerprintError(ValueError):
    """A fingerprint refusal, carrying the fixture's error vocabulary word."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


def _is_experimental(node: object) -> bool:
    return (
        isinstance(node, dict)
        and node.get(STABILITY_KEY) == EXPERIMENTAL_WORD
    )


def _remove_experimental_elements(value: object) -> None:
    """Drop experimental-marked elements, mirroring canonical order exactly.

    Every object-valued member loses its experimental children and every
    array loses its experimental items (`oneOf`, `anyOf`, plain lists —
    no key is special); a `properties` drop also leaves `required`, and
    an emptied `required` drops the key. Members of the root object
    itself are kept, never removed — exactly like
    `remove_experimental_elements`, which only retains children of
    members. In place, like the canonical pass.
    """
    if isinstance(value, dict):
        removed_properties: list[str] = []
        for key, member in value.items():
            if isinstance(member, dict):
                if key == "properties":
                    removed_properties.extend(
                        name
                        for name, child in member.items()
                        if _is_experimental(child)
                    )
                for name in [
                    n for n, child in member.items() if _is_experimental(child)
                ]:
                    del member[name]
            elif isinstance(member, list):
                member[:] = [
                    item for item in member if not _is_experimental(item)
                ]
        required = value.get("required")
        if removed_properties and isinstance(required, list):
            required[:] = [
                entry for entry in required if entry not in removed_properties
            ]
            if not required:
                del value["required"]
        for member in value.values():
            _remove_experimental_elements(member)
    elif isinstance(value, list):
        value[:] = [item for item in value if not _is_experimental(item)]
        for item in value:
            _remove_experimental_elements(item)


def _strip_definitions(document: dict[str, object]) -> tuple[dict[str, object], set[str]]:
    """Strip experimental surface, returning the doc and removed `$defs` names.

    The names travel as a set — never smuggled through a live document
    key — so a top-level `__removed__` member stays input bytes.
    """
    defs = document.get("$defs")
    removed = (
        {name for name, member in defs.items() if _is_experimental(member)}
        if isinstance(defs, dict)
        else set()
    )
    _remove_experimental_elements(document)
    return document, removed


def _find_dangling(document: object, removed: set[str]) -> str | None:
    if isinstance(document, dict):
        target = document.get("$ref")
        if isinstance(target, str) and target.startswith("#/$defs/"):
            name = target[len("#/$defs/") :]
            if name in removed:
                return name
        for member in document.values():
            found = _find_dangling(member, removed)
            if found is not None:
                return found
    elif isinstance(document, list):
        for item in document:
            found = _find_dangling(item, removed)
            if found is not None:
                return found
    return None


def _first_emptied_enum(document: object) -> str | None:
    if not isinstance(document, dict):
        return None
    defs = document.get("$defs")
    if not isinstance(defs, dict):
        return None
    # JSON object keys are always str; the annotation carries what the
    # dropped isinstance used to prove to the type checker.
    names: list[str] = sorted(defs)
    for name in names:
        member = defs[name]
        if isinstance(member, dict) and member.get("oneOf") == []:
            return name
    return None


def _collapse_single_branch_enums(value: object) -> None:
    if isinstance(value, dict):
        branches = value.get("oneOf")
        if isinstance(branches, list) and len(branches) == 1:
            branch = branches[0]
            if (
                isinstance(branch, dict)
                and set(branch).issubset({"type", "enum", OPENNESS_KEY})
                and branch.get("type") == "string"
                and isinstance(branch.get("enum"), list)
            ):
                del value["oneOf"]
                value["type"] = "string"
                value["enum"] = branch["enum"]
        for member in value.values():
            _collapse_single_branch_enums(member)
    elif isinstance(value, list):
        for item in value:
            _collapse_single_branch_enums(item)


def _sorted(value: object) -> object:
    if isinstance(value, dict):
        return {key: _sorted(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sorted(item) for item in value]
    return value


def bundle_fingerprint(variant: str, schema_json: bytes | str) -> str:
    """Fingerprint schema bytes for `variant` ("stable" or "experimental").

    Raises FingerprintError (with .kind in the fixture vocabulary) for
    unparseable, dangling, emptied, or unencodable inputs, and ValueError
    for an unknown variant.
    """
    if variant not in ("stable", "experimental"):
        raise ValueError(f"unknown bundle variant {variant!r}")
    def _refuse_constant(value: str) -> object:
        # `json` accepts NaN/Infinity by default; the canonical parser
        # refuses them, so this port refuses at parse too, not hash.
        raise FingerprintError(
            "unparseable-document",
            f"bundle document uses non-JSON constant {value}",
        )

    try:
        raw = schema_json.decode("utf-8") if isinstance(schema_json, bytes) else schema_json
        document = json.loads(raw, parse_constant=_refuse_constant)
    except UnicodeDecodeError as error:
        raise FingerprintError(
            "unparseable-document", f"bundle bytes are not valid UTF-8: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise FingerprintError(
            "unparseable-document", f"bundle document is not valid JSON: {error}"
        ) from error
    if variant == "stable" and isinstance(document, dict):
        document, removed = _strip_definitions(document)
        dangling = _find_dangling(document, removed)
        if dangling is not None:
            raise FingerprintError(
                "dangling-reference",
                f"stripping left a reference to `{dangling}`, which the stable "
                "document no longer defines",
            )
        emptied = _first_emptied_enum(document)
        if emptied is not None:
            raise FingerprintError(
                "emptied-enum",
                f"stripping left `{emptied}` with an empty `oneOf`",
            )
    # Collapse is stable-only, like the canonical strip it rides
    # inside: experimental bundles keep their oneOf branches verbatim.
    if variant == "stable":
        _collapse_single_branch_enums(document)
    preimage = {
        "normalization_version": NORMALIZATION_VERSION,
        "domain": DOMAIN,
        "experimental": variant == "experimental",
        "document": _sorted(document),
    }
    try:
        encoded = json.dumps(preimage, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise FingerprintError(
            "unencodable-preimage", f"preimage does not serialize: {error}"
        ) from error
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def main(argv: list[str]) -> int:
    """CLI: `msp_fingerprint.py <stable|experimental> <schema.json|->`.

    Prints the derived fingerprint. For callers that cannot import this
    module (the docs reference generator shells out from Node) — the bytes
    hashed are the file's exact bytes, never a re-serialization; `-` reads
    them from stdin.
    """
    if len(argv) != 3 or argv[1] not in ("stable", "experimental"):
        print(f"usage: {argv[0]} <stable|experimental> <schema.json|->", file=sys.stderr)
        return 2
    if argv[2] == "-":
        schema_json = sys.stdin.buffer.read()
        label = "<stdin>"
    else:
        try:
            with open(argv[2], "rb") as handle:
                schema_json = handle.read()
        except OSError as error:
            print(f"cannot read {argv[2]}: {error}", file=sys.stderr)
            return 1
        label = argv[2]
    try:
        print(bundle_fingerprint(argv[1], schema_json))
    except FingerprintError as error:
        print(f"{label} refuses fingerprinting ({error.kind}): {error}", file=sys.stderr)
        return 1
    return 0


_BUNDLED_SCHEMA_DIRNAME = "_schema"
# How far the live-tree walk looks above the importing file: the
# producing checkout resolves four levels up, the public mirror's python
# tree one further at its verbatim sibling. Ten bounds the walk without
# assuming either depth.
_WALK_LIMIT: int = 10

# The installed distribution this module belongs to when a wheel ships
# it. The resolver asks importlib for this name first, mirroring the
# host-version resolver: an installed copy reads its bundle, a source
# layout reads the live tree.
_DISTRIBUTION = "muse-code-msp"


def _live_schema_bytes(variant: str, anchor: Path) -> bytes | None:
    """The variant's schema bytes from a live checkout above `anchor`, if any.

    Walks up from the anchor file's directory for a
    `schema/msp/<variant>/msp.schema.json` document. No depth is assumed,
    so a relocated source tree resolves the same way as the producing
    checkout.
    """
    directory = anchor.parent
    for _ in range(_WALK_LIMIT):
        candidate = directory / "schema" / "msp" / variant / "msp.schema.json"
        if candidate.is_file():
            return candidate.read_bytes()
        if directory.parent == directory:
            return None
        directory = directory.parent
    return None


def _bundled_schema_bytes(variant: str, anchor: Path) -> bytes | None:
    """The variant's schema bytes bundled beside the anchor file, if any.

    Wheels carry a frozen copy of the schema documents they were built
    against. A source checkout has this directory only as stale staging
    leftovers from an interrupted publish build — it is staged at build
    time and ignored otherwise — so its presence alone never proves an
    install; source layouts read the live tree first.
    """
    candidate = anchor.parent / _BUNDLED_SCHEMA_DIRNAME / variant / "msp.schema.json"
    if candidate.is_file():
        return candidate.read_bytes()
    return None


def _this_copy_is_installed(anchor: Path) -> bool:
    """Whether the importing file is the installed distribution's own copy.

    The distribution answers from importlib, but its mere presence is
    not enough: a source checkout beside an installed wheel is still a
    source layout (and an editable install's files live outside the
    installed location). Only a file inside the installed location
    counts, so an in-checkout install reads its bundle while every
    source shape keeps reading the live tree.
    """
    try:
        location = importlib.metadata.distribution(_DISTRIBUTION).locate_file("")
    except importlib.metadata.PackageNotFoundError:
        return False
    try:
        anchor.relative_to(Path(str(location)).resolve())
    except (ValueError, OSError):
        return False
    return True


def derive_bundle_fingerprint(variant: str) -> str:
    """Fingerprint the `<variant>` schema available to this module.

    Resolution, in order: an installed copy reads the schema copy its
    wheel bundles beside it; otherwise the live checkout above this
    file, then the bundled copy as a fallback. The live tree wins
    wherever a source layout imports, so a stale staged copy can never
    shadow the sources; an install with no live tree reads its frozen
    build-against bytes. With neither, raises ImportError naming both
    places instead of guessing — and unparseable bytes refuse through
    the fixture vocabulary, like any other input.
    """
    if variant not in ("stable", "experimental"):
        raise ValueError(f"unknown bundle variant {variant!r}")
    anchor = Path(__file__).resolve()
    if _this_copy_is_installed(anchor):
        bundled = _bundled_schema_bytes(variant, anchor)
        if bundled is not None:
            return bundle_fingerprint(variant, bundled)
    live = _live_schema_bytes(variant, anchor)
    if live is not None:
        return bundle_fingerprint(variant, live)
    bundled = _bundled_schema_bytes(variant, anchor)
    if bundled is not None:
        return bundle_fingerprint(variant, bundled)
    raise ImportError(
        f"cannot fingerprint the {variant} schema: no live checkout found "
        f"above {anchor} (looked for schema/msp/{variant}/msp.schema.json) "
        f"and no bundled copy beside it "
        f"({_BUNDLED_SCHEMA_DIRNAME}/{variant}/msp.schema.json). Install the "
        "published wheel, which bundles the schema it was built against, or "
        "import from a source checkout."
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
