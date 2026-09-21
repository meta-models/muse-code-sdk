"""The MSP connection plane: the transport-less NDJSON connection machine,
the owned-process spawn path, and host discovery.
"""

from __future__ import annotations

from .connection import (
    Connection,
    DuplexTransport,
    MspError,
    NotificationHandler,
    Params,
    ProtocolError,
    ProtocolErrorHandler,
    RetryDelay,
    ServerRequestHandler,
    create_uuid_v7_mint,
)
from .discovery import discover_muse_bin
from .spawn import (
    ConnectionOptions,
    ExitClassification,
    MspHandshake,
    MuseServeChild,
    ProcessExit,
    SpawnedMspConnection,
    spawn_msp_connection,
)

__all__ = [
    "Connection",
    "ConnectionOptions",
    "DuplexTransport",
    "ExitClassification",
    "MspError",
    "MspHandshake",
    "MuseServeChild",
    "NotificationHandler",
    "Params",
    "ProcessExit",
    "ProtocolError",
    "ProtocolErrorHandler",
    "RetryDelay",
    "ServerRequestHandler",
    "SpawnedMspConnection",
    "create_uuid_v7_mint",
    "discover_muse_bin",
    "spawn_msp_connection",
]
