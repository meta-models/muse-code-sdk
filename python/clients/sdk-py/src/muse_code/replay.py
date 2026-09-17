"""The transcript replay runner.

Parses the golden-transcript format (``{"dir","raw"}`` NDJSON), feeds the
server-side notifications to a :class:`muse_code.fold.SessionFold`, and
exposes the client lines for frame-level assertions. Usable as a library by
the corpus suite, the quickstart journey, and the cookbook harnesses; it
authors no fixtures of its own — a missing scenario is a fixture request
against the upstream transcript corpus.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fold import FoldOutcome, SessionFold


@dataclass(frozen=True)
class TranscriptLine:
    """One recorded wire line: its direction and the parsed frame.

    Attributes:
        direction: ``"client"`` (written to the host's stdin) or
            ``"server"`` (read from its stdout).
        frame: The ``raw`` bytes parsed as one JSON-RPC 2.0 frame. Client
            lines may end with ``\\r`` on the wire (tolerated, SS1.1); the
            parse is unaffected.
    """

    direction: str
    frame: dict[str, Any]


@dataclass
class Transcript:
    """A parsed golden transcript plus the outcomes of folding it.

    Attributes:
        scenario: The scenario id (the directory name, equal to the
            manifest's ``scenario``).
        lines: Every recorded line, in wire order.
        fold_outcomes: One :class:`FoldOutcome` per server notification fed
            to the fold by :func:`replay_into_fold`, populated by that call.
    """

    scenario: str
    lines: list[TranscriptLine]
    fold_outcomes: list[FoldOutcome] = field(default_factory=list)

    @property
    def client_frames(self) -> list[dict[str, Any]]:
        """The frames the recorded client sent, in order."""
        return [ln.frame for ln in self.lines if ln.direction == "client"]

    @property
    def server_frames(self) -> list[dict[str, Any]]:
        """The frames the recorded host emitted, in order."""
        return [ln.frame for ln in self.lines if ln.direction == "server"]

    @property
    def server_notifications(self) -> list[dict[str, Any]]:
        """Server frames that are notifications (a ``method``, no ``id``).

        Server-initiated REQUESTS (they carry an ``id``) and responses are
        not fold inputs; the view plane folds notifications only.
        """
        return [
            frame
            for frame in self.server_frames
            if "method" in frame and "id" not in frame
        ]


def transcript_dirs(corpus_root: Path) -> list[Path]:
    """Every scenario directory under the corpus root, sorted by name.

    Args:
        corpus_root: ``schema/msp/transcripts``.

    Returns:
        The scenario directories (those carrying a ``transcript.ndjson``).
    """
    return sorted(
        (
            entry
            for entry in corpus_root.iterdir()
            if (entry / "transcript.ndjson").is_file()
        ),
        key=lambda p: p.name,
    )


def load_transcript(scenario_dir: Path) -> Transcript:
    """Parses one scenario's ``transcript.ndjson``.

    Args:
        scenario_dir: The scenario directory.

    Returns:
        The parsed transcript, fold not yet run.

    Raises:
        ValueError: A line is not the ``{"dir","raw"}`` shape or its ``raw``
            is not one standalone JSON object (the format contract,
            ``schema/msp/transcripts/README.md``).
    """
    path = scenario_dir / "transcript.ndjson"
    lines: list[TranscriptLine] = []
    for line_number, text in enumerate(path.read_text().splitlines(), start=1):
        if not text.strip():
            continue
        record = json.loads(text)
        direction = record.get("dir")
        raw = record.get("raw")
        if direction not in ("client", "server") or not isinstance(raw, str):
            raise ValueError(f"{path}:{line_number}: not a {{dir,raw}} record")
        frame = json.loads(raw)
        if not isinstance(frame, dict):
            raise ValueError(f"{path}:{line_number}: raw is not a JSON object")
        lines.append(TranscriptLine(direction=direction, frame=frame))
    return Transcript(scenario=scenario_dir.name, lines=lines)


def replay_into_fold(transcript: Transcript) -> SessionFold:
    """Feeds the transcript's server notifications through a fresh fold.

    Every notification's outcome is appended to
    ``transcript.fold_outcomes`` (cleared first), so a caller can assert on
    what the fold did per frame — the Scenario 1 discipline checks.

    Args:
        transcript: A parsed transcript.

    Returns:
        The folded state.
    """
    fold = SessionFold()
    transcript.fold_outcomes.clear()
    for frame in transcript.server_notifications:
        transcript.fold_outcomes.append(fold.apply(frame))
    return fold
