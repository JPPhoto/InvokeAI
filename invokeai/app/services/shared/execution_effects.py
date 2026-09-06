"""Typed execution effects recorded while an invocation runs.

This module is deliberately independent of graph materialization. It provides
validated references and a per-invocation effect batch for the execution
engine migration.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from invokeai.app.util.misc import uuid_string

if TYPE_CHECKING:
    from invokeai.app.invocations.baseinvocation import BaseInvocationOutput


def _normalize_aliases(value: Any, aliases: dict[str, tuple[str, ...]]) -> Any:
    if not isinstance(value, dict):
        return value

    data = dict(value)
    for canonical, alternative_names in aliases.items():
        names = (canonical, *alternative_names)
        present = [name for name in names if name in data]
        if not present:
            continue
        if canonical not in data:
            data[canonical] = data[present[0]]
        if any(data[name] != data[canonical] for name in present if name != canonical):
            raise ValueError(f"Conflicting values for {canonical}")
        for name in alternative_names:
            data.pop(name, None)
    return data


class _ExecutionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ExecutionToken(_ExecutionModel):
    """Stable identity for one invocation output in one iteration frame."""

    node_id: str = Field(min_length=1, description="The execution node id.")
    field: str = Field(min_length=1, description="The output field name.")
    value: Any | None = Field(default=None, description="The typed value carried by this token.")
    frame: tuple[int | str, ...] = Field(default=(), description="The enclosing execution frame path.")
    token_kind: Literal["data", "activation", "stream_end"] = Field(
        default="data", description="The semantic kind of this token."
    )
    sequence: int | None = Field(default=None, ge=0, description="Stable order within a stream or frame.")

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_names(cls, value: Any) -> Any:
        return _normalize_aliases(
            value,
            {
                "node_id": ("invocation_id",),
                "field": ("port", "output", "output_name"),
                "frame": ("iteration_path", "frame_path"),
            },
        )

    @field_validator("node_id", "field")
    @classmethod
    def _reject_blank_names(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("frame")
    @classmethod
    def _reject_invalid_frame_parts(cls, value: tuple[int | str, ...]) -> tuple[int | str, ...]:
        if any(isinstance(part, int) and part < 0 for part in value):
            raise ValueError("frame values must be non-negative")
        if any(isinstance(part, str) and not part.strip() for part in value):
            raise ValueError("frame values must not be blank")
        return value

    @property
    def invocation_id(self) -> str:
        return self.node_id

    @property
    def port(self) -> str:
        return self.field

    @property
    def output_name(self) -> str:
        return self.field

    @property
    def iteration_path(self) -> tuple[int | str, ...]:
        return self.frame

    @property
    def source_node_id(self) -> str:
        return self.node_id

    @property
    def source_field(self) -> str:
        return self.field

    @property
    def frame_path(self) -> tuple[int | str, ...]:
        return self.frame


class ExecutionRef(_ExecutionModel):
    """Frame-aware reference to an execution token."""

    token: ExecutionToken | None = None
    template_node_id: str | None = Field(default=None, min_length=1)
    execution_node_id: str | None = Field(default=None, min_length=1)
    frame_path: tuple[int | str, ...] = ()
    scope: Literal["iteration", "final"] = "final"

    @model_validator(mode="before")
    @classmethod
    def _accept_token_fields(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if "token" not in data and any(name in data for name in ("node_id", "invocation_id", "field", "port", "output", "output_name")):
            token_fields = {
                name: data.pop(name)
                for name in (
                    "node_id",
                    "invocation_id",
                    "field",
                    "port",
                    "output",
                    "output_name",
                    "frame",
                    "iteration_path",
                    "frame_path",
                )
                if name in data
            }
            data["token"] = token_fields
        if "execution_node_id" not in data:
            if "node_id" in data:
                data["execution_node_id"] = data["node_id"]
            elif isinstance(data.get("token"), dict):
                token_data = data["token"]
                data["execution_node_id"] = token_data.get("node_id", token_data.get("invocation_id"))
        if "frame_path" not in data and isinstance(data.get("token"), dict):
            token_data = data["token"]
            data["frame_path"] = token_data.get("frame", token_data.get("iteration_path", ()))
        for alias in ("node_id", "invocation_id", "field", "port", "output", "output_name", "frame", "iteration_path"):
            data.pop(alias, None)
        return data

    @model_validator(mode="after")
    def _require_execution_identity(self) -> "ExecutionRef":
        if self.token is None and self.execution_node_id is None:
            raise ValueError("execution reference requires a token or execution_node_id")
        if self.token is not None:
            if "execution_node_id" in self.model_fields_set and self.execution_node_id not in (
                None,
                self.token.node_id,
            ):
                raise ValueError("execution_node_id conflicts with token node_id")
            if "frame_path" in self.model_fields_set and self.frame_path != self.token.frame:
                raise ValueError("frame_path conflicts with token frame")
        return self

    @property
    def node_id(self) -> str:
        if self.execution_node_id is not None:
            return self.execution_node_id
        assert self.token is not None
        return self.token.node_id

    @property
    def field(self) -> str:
        return self.token.field if self.token is not None else ""

    @property
    def frame(self) -> tuple[int | str, ...]:
        return self.frame_path or (self.token.frame if self.token is not None else ())

    @property
    def invocation_id(self) -> str:
        return self.node_id

    @property
    def output_name(self) -> str:
        return self.field

    @property
    def iteration_path(self) -> tuple[int | str, ...]:
        return self.frame


class ExecutionEffect(_ExecutionModel):
    """Base type for a recorded execution effect."""

    kind: str = Field(min_length=1)
    execution_ref: ExecutionRef | None = Field(
        default=None, description="The execution reference that owns this effect, when available."
    )

    @field_validator("kind")
    @classmethod
    def _reject_blank_kind(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class SetValueEffect(ExecutionEffect):
    kind: Literal["set_value"] = "set_value"
    target: ExecutionRef
    value: Any


class AddEdgeEffect(ExecutionEffect):
    kind: Literal["add_edge"] = "add_edge"
    source: ExecutionRef
    destination: ExecutionRef


class RemoveEdgeEffect(ExecutionEffect):
    kind: Literal["remove_edge"] = "remove_edge"
    source: ExecutionRef
    destination: ExecutionRef


class EmitEffect(ExecutionEffect):
    kind: Literal["emit"] = "emit"
    token: ExecutionToken
    value: Any | None = None


class CloseStreamEffect(ExecutionEffect):
    kind: Literal["close_stream"] = "close_stream"
    token: ExecutionToken


class SpawnExecutionEffect(ExecutionEffect):
    kind: Literal["spawn_execution"] = "spawn_execution"
    parent: ExecutionRef
    graph: Any
    inputs: dict[str, Any] = Field(default_factory=dict)
    child_execution_id: str = Field(min_length=1)
    authorization_context: dict[str, Any] | None = None

    @field_validator("graph")
    @classmethod
    def _reject_missing_graph(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("spawn graph must not be None")
        return value

    @field_validator("inputs")
    @classmethod
    def _validate_input_names(cls, value: dict[str, Any]) -> dict[str, Any]:
        if any(not name.strip() for name in value):
            raise ValueError("spawn input names must not be blank")
        return value


class AwaitEffect(ExecutionEffect):
    kind: Literal["await"] = "await"
    dependency: ExecutionRef


class FailEffect(ExecutionEffect):
    kind: Literal["fail"] = "fail"
    message: str = Field(min_length=1)


ExecutionEffectModel = Union[
    SetValueEffect,
    AddEdgeEffect,
    RemoveEdgeEffect,
    EmitEffect,
    CloseStreamEffect,
    SpawnExecutionEffect,
    AwaitEffect,
    FailEffect,
]

# Descriptive aliases keep call sites free to use execution-specific names.
SetExecutionValueEffect = SetValueEffect
AddExecutionEdgeEffect = AddEdgeEffect
RemoveExecutionEdgeEffect = RemoveEdgeEffect
EmitExecutionEffect = EmitEffect


class ExecutionInterface:
    """Restricted recorder facade exposed to invocation code."""

    def __init__(
        self,
        recorder: "ExecutionEffectsRecorder",
        authorize_workflow: Callable[[str], Any] | None = None,
    ) -> None:
        self._recorder = recorder
        self._authorize_workflow = authorize_workflow

    def emit(
        self,
        field: str,
        value: Any,
        *,
        frame: tuple[int | str, ...] | None = None,
        sequence: int | None = None,
        token_kind: Literal["data", "activation"] = "data",
    ) -> None:
        self._recorder.record(
            EmitEffect(
                token=ExecutionToken(
                    node_id=self._recorder.source_node_id,
                    field=field,
                    value=value,
                    frame=frame or self._recorder.frame_path,
                    token_kind=token_kind,
                    sequence=sequence,
                ),
                value=value,
            )
        )

    def close_stream(self, field: str, *, frame: tuple[int | str, ...] | None = None) -> None:
        self._recorder.record(
            CloseStreamEffect(
                token=ExecutionToken(
                    node_id=self._recorder.source_node_id,
                    field=field,
                    frame=frame or self._recorder.frame_path,
                    token_kind="stream_end",
                )
            )
        )

    def spawn(
        self,
        graph: Any,
        inputs: dict[str, Any],
        *,
        child_execution_id: str | None = None,
        authorization_context: dict[str, Any] | None = None,
    ) -> "ChildExecutionHandle":
        owner = ExecutionRef(execution_node_id=self._recorder.source_node_id, frame_path=self._recorder.frame_path)
        handle = ChildExecutionHandle(
            child_execution_id=child_execution_id or uuid_string(),
            parent_execution_id=self._recorder.source_node_id,
            authorization_context=authorization_context,
        )
        self._recorder.record(
            SpawnExecutionEffect(
                execution_ref=owner,
                parent=owner,
                graph=graph,
                inputs=inputs,
                child_execution_id=handle.child_execution_id,
                authorization_context=handle.authorization_context,
            )
        )
        return handle

    def await_dependency(self, dependency: ExecutionRef) -> None:
        owner = ExecutionRef(execution_node_id=self._recorder.source_node_id, frame_path=self._recorder.frame_path)
        self._recorder.record(AwaitEffect(execution_ref=owner, dependency=dependency))

    def fail(self, message: str) -> None:
        owner = ExecutionRef(execution_node_id=self._recorder.source_node_id, frame_path=self._recorder.frame_path)
        self._recorder.record(FailEffect(execution_ref=owner, message=message))

    def authorize_workflow(self, workflow_id: str) -> Any:
        if self._authorize_workflow is None:
            raise PermissionError("workflow authorization is unavailable in this execution context")
        return self._authorize_workflow(workflow_id)


class ChildExecutionHandle(_ExecutionModel):
    """Validated identity and authorization metadata for a spawned child."""

    child_execution_id: str = Field(min_length=1)
    parent_execution_id: str = Field(min_length=1)
    authorization_context: dict[str, Any] | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_compatibility_names(cls, value: Any) -> Any:
        return _normalize_aliases(
            value,
            {
                "child_execution_id": ("child_id", "execution_id"),
                "parent_execution_id": ("parent_id",),
                "authorization_context": ("authorization", "auth_context"),
            },
        )

    @field_validator("child_execution_id", "parent_execution_id")
    @classmethod
    def _reject_blank_ids(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @property
    def child_id(self) -> str:
        return self.child_execution_id

    @property
    def execution_id(self) -> str:
        return self.child_execution_id

    @property
    def parent_id(self) -> str:
        return self.parent_execution_id

    @property
    def authorization(self) -> dict[str, Any] | None:
        return self.authorization_context


@dataclass(frozen=True)
class ExecutionEffectBatch:
    effects: tuple[ExecutionEffect, ...]

    def __iter__(self):
        return iter(self.effects)

    def __len__(self) -> int:
        return len(self.effects)

    def __bool__(self) -> bool:
        return bool(self.effects)


class ExecutionEffectsRecorder:
    """Collects effects for one invocation run."""

    def __init__(self, source_node_id: str = "context", frame_path: tuple[int | str, ...] = ()) -> None:
        self._effects: list[ExecutionEffect] = []
        self.source_node_id = source_node_id
        self.frame_path = frame_path

    def record(self, effect: ExecutionEffect) -> None:
        if not isinstance(effect, ExecutionEffect):
            raise TypeError(f"Expected ExecutionEffect, got {type(effect).__name__}")
        self._effects.append(effect)

    record_effect = record

    def snapshot(self) -> tuple[ExecutionEffect, ...]:
        return tuple(self._effects)

    def drain(self) -> tuple[ExecutionEffect, ...]:
        """Return all recorded effects and reset the recorder."""
        effects = self.snapshot()
        self.clear()
        return effects

    def batch(self) -> ExecutionEffectBatch:
        return ExecutionEffectBatch(effects=self.snapshot())

    def clear(self) -> None:
        self._effects.clear()

    @property
    def effects(self) -> tuple[ExecutionEffect, ...]:
        return self.snapshot()


ExecutionEffectRecorder = ExecutionEffectsRecorder


@dataclass(frozen=True)
class InvocationRunResult:
    """Invocation output plus effects recorded during that run."""

    output: "BaseInvocationOutput"
    effects: tuple[ExecutionEffect, ...]

    @property
    def invocation_output(self) -> "BaseInvocationOutput":
        return self.output

    @property
    def effect_batch(self) -> ExecutionEffectBatch:
        return ExecutionEffectBatch(effects=self.effects)
