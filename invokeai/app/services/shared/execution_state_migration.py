"""Compatibility helpers for persisted internal execution-state snapshots."""

from collections.abc import Mapping
from typing import Any, Final

from invokeai.app.services.shared.graph import GraphExecutionState

CURRENT_EXECUTION_STATE_VERSION: Final[int] = 1


class UnsupportedExecutionStateVersionError(ValueError):
    """Raised when an execution-state snapshot cannot be read by this runtime."""


def dump_execution_state(state: GraphExecutionState) -> dict[str, Any]:
    """Dump an internal execution state with an additive version marker.

    The marker stays alongside the existing state fields so rolling deployments
    and diagnostic tools that still deserialize the legacy raw shape continue
    to work. The loader also accepts the temporary envelope form used by early
    migration experiments.
    """
    snapshot = state.model_dump(mode="json", warnings=False, exclude_none=True)
    snapshot["execution_state_version"] = CURRENT_EXECUTION_STATE_VERSION
    return snapshot


def load_execution_state(snapshot: Mapping[str, Any]) -> GraphExecutionState:
    """Load a versioned snapshot or a legacy unwrapped execution state."""
    if not isinstance(snapshot, Mapping):
        raise TypeError("Execution state snapshot must be a mapping")

    if "version" not in snapshot and "execution_state_version" not in snapshot:
        return GraphExecutionState.model_validate(snapshot, strict=False)

    if "version" in snapshot:
        version = snapshot["version"]
        payload = snapshot.get("state")
        if not isinstance(payload, Mapping):
            raise ValueError("Versioned execution state snapshot must contain a mapping in 'state'")
    else:
        version = snapshot["execution_state_version"]
        payload = dict(snapshot)
        payload.pop("execution_state_version", None)

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

    return GraphExecutionState.model_validate(payload, strict=False)
