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

Baseline behavior from main:

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

- Durable body identity metadata for nested or shared loop body paths.
- Visual editor affordances for a structured loop body boundary.
- Early break or continue behavior.
- Rich collection producer nodes designed specifically for loop sources.

Implemented on this branch:

- `For` and `ForReturn` scheduler-special invocation definitions.
- Output-scope metadata for iteration-scoped and final-scoped outputs.
- Validation for the currently supported `For -> ... -> ForReturn` loop boundary.
- Runtime materialization for direct `For -> ForReturn` iteration continuations.
- Runtime rematerialization for body nodes on the reachable path from `For` iteration outputs to `ForReturn`.
- External body inputs are reused for each rematerialized body iteration when their source has a prepared execution node.
- Loop-carried `LoopState` for direct and rematerialized body iterations.
- Ordinary loop state helper invocations: `state_empty`, `state_get`, `state_set`, and `state_merge`.
- Final-scoped `For.output_collection` and `For.final_state` release after loop completion.
- Empty collection finalization.

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

## Current Implementation Boundary

The current incremental implementation supports a bounded body path from iteration-scoped `For` outputs to one matching
`ForReturn`:

```text
For.iteration_output -> ForReturn.input
For.iteration_output -> BodyNode.input -> ForReturn.input
```

The runtime schedules the next `For` iteration when the matching `ForReturn` completes, carries `LoopState` forward, and
rematerializes the reachable body path for the next iteration. Final-scoped outputs release after the last matching
`ForReturn` completes.

The current body rematerializer copies edges whose source is the `For` node, another node in the loop body path, or an
already prepared node outside the body path. That supports shared configuration or prompt inputs:

```text
ExternalNode.output -> BodyNode.input
```

If a future body shape requires an input source that cannot be mapped to a prepared execution node, the rematerializer
must reject that graph shape or add the missing preparation rule. The implementation should prefer rejecting unsupported
loop bodies over allowing valid-looking workflows that silently change inputs after the first iteration.

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

The exact metadata name is open. This metadata does not exist as a complete engine contract today, so implementing `For`
requires schema, validation, frontend type generation, workflow serialization, and execution-graph materialization to
preserve the output scope. A `For` node cannot be implemented as an ordinary invocation that only returns one flat output
model.

The distinction is required:

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

The loop should require exactly one matching body return node in its body boundary for the first implementation.
Default return behavior can be added later, but it would make the boundary harder to validate.

For the target implementation, the recommended body boundary is a boundary pair:

- `For` starts the body through its iteration-scoped outputs.
- `ForReturn` ends the body for one iteration.
- The loop body is the reachable subgraph from `For` iteration-scoped outputs to the matching `ForReturn`.

The `ForReturn` must be associated with a specific source `For`. Reachability alone is not sufficient once nested loops
or shared body paths are allowed, because the backend must know which return node closes which loop. The first
implementation should either reject nested `For` bodies or add durable body identity metadata before allowing them.

This is simpler than a full visual subgraph while still giving the backend an explicit return boundary. Validation must
also reject loop-body paths that escape to after-loop nodes without passing through the matching `ForReturn`.

The current branch implements this reachable body-path subset. More complex boundaries, shared paths, and nested loops
require durable body identity metadata and should remain future work.

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

`For` and `ForReturn` are scheduler-special boundary nodes in this model. The visible node maps to synthetic prepared
execution nodes for history, errors, and resume, but the loop behavior is not just the result of calling a normal
`invoke()` method once.

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
- final `output_collection` is empty
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

During incremental implementation, final-scoped `For` outputs may exist in the schema before the runtime final prepared
node exists. In that state, edges from `For.output_collection` and `For.final_state` must not be materialized from
per-iteration `For` execution nodes. They should remain blocked until the scheduler can create a final loop execution
surface after all iterations complete.

### 6. Cancellation And Partial Results

If execution is cancelled or fails before the final loop output is produced, partially aggregated outputs must remain
internal execution state. Downstream after-loop nodes should not observe partial `output_collection` or `final_state`
values.

### 7. Ordering

The first implementation should run iterations sequentially when state is used.

Parallel execution may be considered later for stateless loops, but only if it preserves deterministic collection order
and does not change visible graph semantics.

### 8. Persistence And Resume

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

### 9. Caching

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
- Output-scope metadata must survive saved workflow JSON, backend schema generation, frontend type generation, and graph
  preparation.
- A loop body must expose exactly one matching body return node.
- A body return's `state` input must be compatible with `LoopState`.
- The author-time graph must remain acyclic.
- Nodes inside the loop body must not feed after-loop nodes directly.
- Nested `For` loops must be rejected until the body boundary has durable identity metadata.

First implementation recommendation:

- Use a boundary pair rather than a full visual subgraph.
- The body is reachable from iteration-scoped `For` outputs and terminates at one `ForReturn`.
- Shared paths that escape the body before `ForReturn` should be rejected unless a clear rule is added later.

Open design question:

- The editor and backend need a durable saved-workflow representation for the body boundary. This may be output-scope
  metadata plus reachability validation for the first implementation if nested loops are rejected, with explicit body
  membership metadata or a visual subgraph added later.

## Editor Contract

The editor should present `For` as a loop boundary rather than as an ordinary value node.

Minimum editor behavior:

- show `collection` and optional `state` inputs
- show per-iteration outputs in a distinct "Iteration Outputs" section: `item`, `index`, `total`, `state`
- show final outputs in a distinct "Final Outputs" section: `output_collection`, `final_state`
- make the body return node discoverable and understandable
- prevent invalid body return wiring where possible

The ordinary node renderer and connection validation need enough output-scope metadata to distinguish these sections.
This is not only a visual grouping; it changes which connections are loop-body edges and which connections are
after-loop edges.

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

## Future Loop Architecture Extensions

The first implementation is intentionally scoped to a bounded collection-based `For`, but several parts of the
architecture are meant to be reusable by later loop-like nodes:

- output scopes that distinguish body edges from after-loop edges
- explicit body boundaries between a loop entry node and a matching return or continuation node
- explicit loop-carried state that can be serialized, resumed, and tested
- scheduler materialization that maps one visible author-time node to multiple prepared execution surfaces
- validation rules that prevent body edges from leaking into after-loop execution

Potential extensions should build on those pieces instead of introducing hidden graph cycles or process-local mutable
state.

Possible future loop-like nodes:

- `While`: repeats while a condition remains true. This requires a condition value that is evaluated after each body
  return and a hard stop policy to avoid unbounded execution.
- `Map`: applies a body to every item in a collection and collects outputs. This may be a constrained `For` variant
  with no loop-carried state and potential parallel execution.
- `Reduce`: carries state across a collection and returns a final accumulator. This is close to a stateful `For` with
  required state and optional suppression of per-item output collection.
- `Filter`: evaluates a body or predicate for every item and returns only selected items. This can reuse iteration
  scoping but needs a clear predicate output contract.
- `Repeat`: runs a body a fixed number of times. This can be modeled as `Range -> For.collection`, so it should only
  become a separate node if the UX benefit justifies the extra primitive.

The collection-based `For` should remain the proving ground for the shared architecture. Later nodes should be added
only when their behavior cannot be expressed clearly by collection producer nodes plus `For`, or when a narrower node
can provide stronger validation, simpler UI, or safer execution semantics.

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
- cancellation or failure does not expose partial final outputs to after-loop nodes
- serialized `GraphExecutionState` can resume a partially completed loop
- cache does not collapse distinct stateful iterations
- nested `For` bodies are rejected until body identity metadata exists
- body paths that feed after-loop nodes directly are rejected
- saved workflow JSON preserves output-scope metadata

Frontend tests should cover:

- graph validation for loop source and state wiring
- graph validation for iteration-scoped vs final-scoped output edges
- workflow serialization and deserialization of loop nodes
- workflow serialization and deserialization preserve output-scope metadata
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
3. Preserve output-scope metadata through saved workflows, backend schemas, frontend types, and graph preparation.
4. Add graph validation for the bounded collection-based loop shape and matching `ForReturn` body boundary.
5. Reject nested loops and body paths that escape directly to after-loop nodes until durable body identity metadata
   exists.
6. Extend `GraphExecutionState` materialization to create one iteration context at a time.
7. Route iteration-scoped outputs into body execution nodes and final-scoped outputs into after-loop nodes.
8. Carry explicit returned state into the next iteration.
9. Aggregate final output collection and final state.
10. Add serialization/resume tests.
11. Add editor affordances after the backend contract is stable.

The first milestone should prove fixed collection iteration with explicit state carry. Early break, parallel stateless
loops, richer collection producers, and visual loop-body editing can follow after that contract is stable.
