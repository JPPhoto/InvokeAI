"""Compatibility helpers for persisted internal execution-state snapshots."""

from collections.abc import Mapping
from typing import Any, Final

from invokeai.app.services.shared.graph import GraphExecutionState

CURRENT_EXECUTION_STATE_VERSION: Final[int] = 1


class UnsupportedExecutionStateVersionError(ValueError):
    """Raised when an execution-state snapshot cannot be read by this runtime."""


def dump_execution_state(state: GraphExecutionState) -> dict[str, Any]:
    """Dump an internal execution state in its versioned snapshot envelope."""
    return {
        "version": CURRENT_EXECUTION_STATE_VERSION,
        "state": state.model_dump(mode="json", warnings=False, exclude_none=True),
    }


def load_execution_state(snapshot: Mapping[str, Any]) -> GraphExecutionState:
    """Load a versioned snapshot or a legacy unwrapped execution state."""
    if not isinstance(snapshot, Mapping):
        raise TypeError("Execution state snapshot must be a mapping")

    if "version" not in snapshot:
        return GraphExecutionState.model_validate(snapshot, strict=False)

    version = snapshot["version"]
    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError("Execution state snapshot version must be an integer")
    if version > CURRENT_EXECUTION_STATE_VERSION:
        raise UnsupportedExecutionStateVersionError(
            f"Execution state snapshot version {version} is newer than supported version "
            f"{CURRENT_EXECUTION_STATE_VERSION}"
        )
    if version != CURRENT_EXECUTION_STATE_VERSION:
        raise UnsupportedExecutionStateVersionError(
            f"Execution state snapshot version {version} is unsupported; current version is "
            f"{CURRENT_EXECUTION_STATE_VERSION}"
        )

    state = snapshot.get("state")
    if not isinstance(state, Mapping):
        raise ValueError("Versioned execution state snapshot must contain a mapping in 'state'")
    return GraphExecutionState.model_validate(state, strict=False)
