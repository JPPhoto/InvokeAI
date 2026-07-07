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

- `output_collection: list[Any]`
- `final_state: LoopState`

The per-iteration outputs and final outputs must be distinguishable by schema metadata. A `For` node is not an ordinary
flat invocation where every output has the same execution scope.

Potential output metadata:

```py
item: Any = OutputField(..., loop_scope="iteration")
output_collection: list[Any] = OutputField(..., loop_scope="final")
```

The exact metadata name is open, but the distinction is required:

- edges from iteration-scoped outputs are loop-body edges
- edges from final-scoped outputs are after-loop edges

This avoids ambiguity between `For.state` as the state provided to the current iteration and `For.final_state` as the
state produced after the loop completes.

### 3. For Return Node

A body return node should make the loop body contract explicit.

Inputs:

- `output: Any | None = None`
- `state: LoopState | None = None`

Outputs:

- `output: Any | None`
- `state: LoopState | None`

Semantics:

- `output` is appended to the final `For.output_collection` when present.
- `state` becomes the next iteration's state when present.
- If `state` is omitted, the previous state carries forward unchanged.

The loop should require either exactly one body return node in its body boundary or a clearly defined default return
behavior. Requiring a return node is more explicit and easier to validate.

For the first implementation, the recommended body boundary is a boundary pair:

- `For` starts the body through its iteration-scoped outputs.
- `ForReturn` ends the body for one iteration.
- The loop body is the reachable subgraph from `For` iteration-scoped outputs to the matching `ForReturn`.

This is simpler than a full visual subgraph while still giving the backend an explicit return boundary.

### 4. Runtime Shape

The author-time graph may show one `For` node, but the runtime execution graph should treat iteration and final outputs
as separate prepared execution surfaces.

Author-time graph:

```text
Range -> For.collection

For.item -> BodyNode.input
BodyNode.output -> ForReturn.output

For.output_collection -> AfterLoopNode.collection
For.final_state -> AfterLoopNode.state
```

Runtime execution graph:

```text
ForIter[0].item -> BodyNode[0].input -> ForReturn[0].output
ForIter[1].item -> BodyNode[1].input -> ForReturn[1].output
ForIter[2].item -> BodyNode[2].input -> ForReturn[2].output

ForFinal.output_collection -> AfterLoopNode.collection
ForFinal.final_state -> AfterLoopNode.state
```

For stateful loops:

```text
ForIter[0].state -> BodyNode[0] -> ForReturn[0].state
ForReturn[0].state -> ForIter[1].state
ForReturn[1].state -> ForIter[2].state
ForReturn[2].state -> ForFinal.final_state
```

The source `For` node can remain one visible node, but the materializer needs to know which output fields route to
per-iteration prepared nodes and which output fields route to the final prepared node.

### 5. State Helper Nodes

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

Downstream nodes after the loop receive data through normal edges from the final-scoped outputs:

- `For.output_collection`
- `For.final_state`

Those downstream nodes become ready only after the final prepared execution node for the loop is complete. They should
not depend on or see per-iteration prepared outputs directly unless they are part of the loop body.

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

A persisted loop runtime record should be able to represent the current boundary state. For example:

```py
class ForExecution(BaseModel):
    source_for_node_id: str
    total: int
    next_index: int
    current_state: LoopState
    output_items: list[Any]
    prepared_iteration_ids: list[str]
    completed_return_ids: list[str]
    final_exec_node_id: str | None = None
```

The exact model shape may differ, but the runtime needs enough durable state to decide whether the next action is to:

- materialize the next iteration
- wait for the active iteration's `ForReturn`
- materialize or complete the final loop output

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
- Edges from iteration-scoped `For` outputs must be treated as loop-body edges.
- Edges from final-scoped `For` outputs must be treated as after-loop edges.
- A loop body must expose exactly one body return node, unless the default return behavior is explicitly defined.
- A body return's `state` input must be compatible with `LoopState`.
- The author-time graph must remain acyclic.

First implementation recommendation:

- Use a boundary pair rather than a full visual subgraph.
- The body is reachable from iteration-scoped `For` outputs and terminates at one `ForReturn`.
- Shared paths that escape the body before `ForReturn` should be rejected unless a clear rule is added later.

Open design question:

- The editor and backend need a durable saved-workflow representation for the body boundary. This may be output-scope
  metadata plus reachability validation for the first implementation, with explicit body membership metadata or a visual
  subgraph added later.

## Editor Contract

The editor should present `For` as a loop boundary rather than as an ordinary value node.

Minimum editor behavior:

- show `collection` and optional `state` inputs
- show per-iteration outputs in a distinct "Iteration Outputs" section: `item`, `index`, `total`, `state`
- show final outputs in a distinct "Final Outputs" section: `output_collection`, `final_state`
- make the body return node discoverable and understandable
- prevent invalid body return wiring where possible

Suggested first visual shape:

```text
+-----------------------------------+
| For                               |
| Inputs                            |
|   collection                      |
|   state                           |
|                                   |
| Iteration Outputs                 |
|   item                            |
|   index                           |
|   total                           |
|   state                           |
|                                   |
| Final Outputs                     |
|   output_collection               |
|   final_state                     |
+-----------------------------------+
```

The first version does not need a visual subgraph editor, but the graph representation must not block one later. A later
UI may draw a subtle loop region around the reachable body nodes between `For` and `ForReturn`.

## Testing Plan

Backend tests should cover:

- empty collection produces empty output and initial state
- collection items are emitted in order
- index and total are correct for every iteration
- body outputs are collected in iteration order
- final-scoped outputs release after-loop nodes only after all required iteration returns complete
- iteration-scoped outputs are duplicated only into matching loop-body iteration contexts
- initial state reaches the first iteration
- returned state reaches the next iteration
- omitted returned state carries previous state forward
- final state is the last returned state
- body failure stops later iterations
- serialized `GraphExecutionState` can resume a partially completed loop
- cache does not collapse distinct stateful iterations

Frontend tests should cover:

- graph validation for loop source and state wiring
- graph validation for iteration-scoped vs final-scoped output edges
- workflow serialization and deserialization of loop nodes
- type compatibility for `LoopState`
- visual grouping of iteration outputs and final outputs
- editor handling for body return nodes

## Open Questions

- Should the first implementation require an explicit `for_return` node, or should body output be inferred from a
  connected field?
- What is the cleanest durable representation of a loop body boundary in saved workflow JSON?
- Should loop output scope metadata live in invocation output field schema, node UI config, or graph-builder-only
  metadata?
- Should state helper nodes live with core primitives, logic nodes, or a new loop/state node category?
- Should the first implementation collect `None` outputs, skip them, or require an explicit output value?
- How should nested `For` loops expose iteration paths and state without confusing collectors?
- Should early break be added as `continue_condition` on `for_return`, or as a separate `for_continue` node later?

## Incremental Implementation Plan

1. Add `LoopState` schema and state helper nodes.
2. Add `For` and `ForReturn` invocation definitions with scoped output metadata but without runtime behavior beyond
   validation/schema.
3. Add graph validation for the bounded collection-based loop shape and `ForReturn` body boundary.
4. Extend `GraphExecutionState` materialization to create one iteration context at a time.
5. Route iteration-scoped outputs into body execution nodes and final-scoped outputs into after-loop nodes.
6. Carry explicit returned state into the next iteration.
7. Aggregate final output collection and final state.
8. Add serialization/resume tests.
9. Add editor affordances after the backend contract is stable.

The first milestone should prove fixed collection iteration with explicit state carry. Early break, parallel stateless
loops, richer collection producers, and visual loop-body editing can follow after that contract is stable.
