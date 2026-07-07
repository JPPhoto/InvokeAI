---
title: Loop Nodes Architecture
---

## Goal

InvokeAI should support a bounded `For` loop node as an engine-native iteration boundary for workflows.

The first target is a collection-based `For` node, not a fully general `While` node and not arbitrary cyclic graph
execution.

The long-term feature goal is:

- A workflow can iterate over an input collection.
- Each iteration emits the current `item`, `index`, `total`, and optional loop `state`.
- The loop body can produce an output item for collection.
- The loop body can optionally produce updated state for the next iteration.
- The final loop result exposes the collected body outputs and final state.
- The architecture must work for Invoke frontend graphs and for externally submitted graphs that use the same node
  types.

This document records the target architecture and execution contract needed to continue development later.

## Implementation Priority

Favor explicit graph semantics over hidden mutable runtime state.

The work may still proceed incrementally, but each increment should satisfy all of the following:

- testable in isolation
- compatible with the long-term architecture described here
- non-breaking to existing graph execution behavior
- compatible with persisted and resumed graph execution state

The first implementation should keep the loop source narrow. Rich iteration sources should be ordinary collection
producer nodes rather than extra modes on `For`.

## Current State

Implemented already in main:

- `IterateInvocation` expands a collection into per-item execution nodes.
- `CollectInvocation` gathers per-iteration values into a collection.
- `GraphExecutionState` materializes execution nodes from a source graph into an execution graph.
- Execution metadata tracks prepared source mappings and iteration paths.
- Lazy `IfInvocation` branch scheduling can defer and skip branch-local work per prepared execution context.

Implemented in related experimental branches:

- `reevaluate_on_iteration` explores per-iterator-context rematerialization of upstream nodes that otherwise sit outside
  iterator ancestry.
- `transient_storage` explores per-session mutable context shared by invocations in one execution.

Lessons from those branches:

- Per-iteration reevaluation is useful as an execution primitive, but it must not be defeated by ordinary invocation
  cache behavior.
- Hidden transient storage is useful for private node internals, but it should not be the primary contract for loop
  state.
- Loop-carried state should be explicit graph data so it is visible, serialized, resumable, and testable.

What is still not implemented:

- A real `For` invocation exists.
- A loop body boundary exists.
- A return or continuation node exists for body outputs and next state.
- Runtime materialization does not yet carry state from one iteration context to the next.
- The editor does not yet represent a loop body boundary or per-iteration outputs as a structured loop interface.

## Architectural Direction

Use a bounded collection-based loop as the first durable primitive.

The `For` node should have one loop source:

- `collection: list[Any]`

Other iteration sources should be separate collection-producing nodes:

- `Range` produces `list[int]`.
- `Board Images` produces `list[ImageField]`.
- `Model List` produces a list of model identifiers.
- `Zip` produces a collection of tuples or records.
- `Cartesian Product` produces a collection of combinations.

This is preferred over multiple mutually exclusive `For` inputs because it:

- avoids ambiguous validation when more than one source is connected
- keeps the loop primitive small
- lets iteration sources evolve as ordinary nodes
- makes externally submitted graphs easier to validate

Loop state should be explicit, not hidden in `InvocationContext.transient_storage`.

The `For` node may accept optional initial state:

- `state: LoopState | None`

Each iteration emits the current state. The loop body may return updated state. If no updated state is returned, the
previous state carries forward unchanged.

This state model is preferred because it:

- is represented in normal graph edges
- is serialized in normal execution results
- can be inspected and tested
- can survive retry or resume
- does not rely on mutable context side effects

## Non-Goals For The First Phase

These should not be the first implementation target:

- a general `While` node
- unknown or unbounded loop counts
- graph cycles in the author-time graph
- hidden loop state based on `context.transient_storage`
- multiple loop source modes on the `For` node
- early break or continue semantics
- parallel loop-body execution
- automatic inference of arbitrary loop body outputs

Early break can be added later as an explicit continuation contract once fixed collection iteration is stable.

## Proposed Node Shape

### 1. Loop State

Use a wrapper type rather than a naked `dict[str, Any]`.

```py
class LoopState(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
```

The wrapper gives schema-facing code a stable type and leaves room for future metadata, validation, and migrations.

### 2. For Node

The `For` node is the loop boundary.

Inputs:

- `collection: list[Any]`
- `state: LoopState | None = None`

Per-iteration outputs:

- `item: Any`
- `index: int`
- `total: int`
- `state: LoopState`

Final outputs:

- `collection: list[Any]`
- `state: LoopState`

Open design question:

- The implementation may require separate prepared execution nodes for per-iteration values and final values, or a
  dedicated body-return node. The external contract should stay stable even if the internal representation changes.

### 3. For Return Node

A body return node should make the loop body contract explicit.

Inputs:

- `output: Any | None = None`
- `state: LoopState | None = None`

Outputs:

- `output: Any | None`
- `state: LoopState | None`

Semantics:

- `output` is appended to the final `For.collection` when present.
- `state` becomes the next iteration's state when present.
- If `state` is omitted, the previous state carries forward unchanged.

The loop should require either exactly one body return node in its body boundary or a clearly defined default return
behavior. Requiring a return node is more explicit and easier to validate.

### 4. State Helper Nodes

State helper nodes should be ordinary invocations, not special scheduler features.

Useful helpers:

- `state_empty` creates an empty `LoopState`.
- `state_get` reads a value from `LoopState.values` by key.
- `state_set` returns a new `LoopState` with one key updated.
- `state_merge` returns a new `LoopState` with multiple updates applied.

These helpers let workflows opt into state without making every loop body handle dictionaries manually.

## Execution Contract

### 1. Loop Source

The loop source is `For.collection`.

The collection must be available before the loop body can materialize.

If the collection is empty:

- no body iterations run
- final `collection` is empty
- final `state` is the provided initial state or an empty `LoopState`

### 2. Initial State

If `For.state` is connected, the first iteration receives that state.

If `For.state` is not connected, the first iteration receives an empty `LoopState`.

The state value should be copied between iterations so mutation through shared Python object identity cannot leak across
results.

### 3. Per-Iteration Values

For iteration `i`, the loop exposes:

- `item = collection[i]`
- `index = i`
- `total = len(collection)`
- `state = state_from_previous_iteration`

Iteration values are scoped to the current iteration context. Downstream body nodes must use values from the matching
iteration.

### 4. Body Return

The body return for iteration `i` determines:

- the optional output item appended to the final output collection
- the state used by iteration `i + 1`

If the body return omits state, the previous state carries forward.

If body execution fails, normal invocation failure behavior applies and no later iterations should be materialized.

### 5. Final Output

The `For` final output is available only after:

- every iteration has completed successfully, or
- a later explicit early-break contract says the loop is complete

The final output contains:

- collected body output items in iteration order
- final loop state

### 6. Ordering

The first implementation should run iterations sequentially when state is used.

Parallel execution may be considered later for stateless loops, but only if it preserves deterministic collection order
and does not change visible graph semantics.

### 7. Persistence And Resume

Loop execution state must be persisted through `GraphExecutionState`.

At minimum, persisted state must be able to recover:

- which iteration contexts have been prepared
- which iteration contexts have completed
- the state value that should feed the next unstarted iteration
- final output aggregation progress

The loop must not depend on process-local mutable state that disappears on restart.

### 8. Caching

Invocation cache behavior must not collapse distinct loop iterations incorrectly.

Cache keys for body nodes must account for normal prepared input values. If a node depends on loop state, the explicit
state input should participate in its normal invocation value hash.

If a future feature rematerializes stateful nodes outside iterator ancestry, that behavior must either bypass cache or
include the relevant iteration context in the cache key.

## Validation Contract

Graph validation should reject ambiguous loop structures before runtime.

Potential validation rules:

- `For.collection` must be connected or provided as a direct value.
- `For.state`, when connected, must be compatible with `LoopState`.
- A loop body must expose exactly one body return node, unless the default return behavior is explicitly defined.
- A body return's `state` input must be compatible with `LoopState`.
- The author-time graph must remain acyclic.

Open design question:

- The editor and backend need a durable way to identify the body boundary. This may require explicit body membership
  metadata, a subgraph-like container, or a pair of boundary invocations.

## Editor Contract

The editor should present `For` as a loop boundary rather than as an ordinary value node.

Minimum editor behavior:

- show `collection` and optional `state` inputs
- show per-iteration outputs: `item`, `index`, `total`, `state`
- show final outputs: `collection`, `state`
- make the body return node discoverable and understandable
- prevent invalid body return wiring where possible

The first version does not need a visual subgraph editor, but the graph representation must not block one later.

## Testing Plan

Backend tests should cover:

- empty collection produces empty output and initial state
- collection items are emitted in order
- index and total are correct for every iteration
- body outputs are collected in iteration order
- initial state reaches the first iteration
- returned state reaches the next iteration
- omitted returned state carries previous state forward
- final state is the last returned state
- body failure stops later iterations
- serialized `GraphExecutionState` can resume a partially completed loop
- cache does not collapse distinct stateful iterations

Frontend tests should cover:

- graph validation for loop source and state wiring
- workflow serialization and deserialization of loop nodes
- type compatibility for `LoopState`
- editor handling for body return nodes

## Open Questions

- Should the first implementation require an explicit `for_return` node, or should body output be inferred from a
  connected field?
- What is the cleanest durable representation of a loop body boundary in saved workflow JSON?
- Should state helper nodes live with core primitives, logic nodes, or a new loop/state node category?
- Should the first implementation collect `None` outputs, skip them, or require an explicit output value?
- How should nested `For` loops expose iteration paths and state without confusing collectors?
- Should early break be added as `continue_condition` on `for_return`, or as a separate `for_continue` node later?

## Incremental Implementation Plan

1. Add `LoopState` schema and state helper nodes.
2. Add `For` and `ForReturn` invocation definitions without runtime behavior beyond validation/schema.
3. Add graph validation for the bounded collection-based loop shape.
4. Extend `GraphExecutionState` materialization to create one iteration context at a time.
5. Carry explicit returned state into the next iteration.
6. Aggregate final output collection and final state.
7. Add serialization/resume tests.
8. Add editor affordances after the backend contract is stable.

The first milestone should prove fixed collection iteration with explicit state carry. Early break, parallel stateless
loops, richer collection producers, and visual loop-body editing can follow after that contract is stable.
