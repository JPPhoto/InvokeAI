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

- Runtime support for implicit zip or Cartesian loop semantics, or mixed nested loop shapes.

Implemented on this branch:

- `For` and `ForReturn` scheduler-special invocation definitions.
- Output-scope metadata for iteration-scoped and final-scoped outputs.
- Validation for the currently supported `For -> ... -> ForReturn` loop boundary.
- Runtime materialization for direct `For -> ForReturn` iteration continuations.
- Runtime rematerialization for body nodes on the reachable path from `For` iteration outputs to `ForReturn`.
- Runtime rematerialization for one bounded internal `Iterate` whose item stream is collapsed by one `Collect` before
  `ForReturn`, with composite outer/inner iteration paths.
- External body inputs are reused for each rematerialized body iteration when their source has a prepared execution node.
- Loop-carried `LoopState` for direct and rematerialized body iterations.
- Ordinary loop state helper invocations: `state_empty`, `state_get`, `state_set`, and `state_merge`.
- Final-scoped `For.output_collection` and `For.final_state` release after loop completion.
- Empty collection finalization.
- Serialization/resume coverage for partially completed stateful loops.
- Failure handling that stops loop scheduling without releasing partial final outputs.
- Completed prepared `For` iterations release their copied collection after the successor or final output is prepared,
  avoiding quadratic collection retention while preserving serialization and resume behavior.
- Frontend enqueue-time whole-graph validation matching the backend's currently supported loop body shapes.
- A durable `loop_linkage` association edge between each `For` and its matching `ForReturn`, with matching
  frontend/backend validation for missing, stale, duplicate, and mismatched associations.
- Runtime body-boundary resolution consumes `loop_linkage` when selecting a matching reachable `ForReturn`; the
  association edge is not executable data flow and is excluded from scheduling, cycle detection, and input propagation.
- Contextual `ForReturn` discovery in the add-node picker: iteration-output connections prioritize and auto-expand
  `ForReturn`, then reuse ordinary connection validation to select its compatible input.
- Threaded `DefaultSessionProcessor` integration coverage for successful execution, queue-status-event cancellation,
  and body failure.
- Production-style `DefaultSessionProcessor` coverage with the actual SQLite session queue and registered event bus,
  including bounded nested `Iterate` success, cancellation, and body-failure cleanup.
- SQLite session-queue coverage for persisting, reloading, and completing a partially executed stateful loop.
- Runtime support for recursively linked nested `For` boundaries whose final collections feed their parent
  `ForReturn`, including multiple outer contexts, empty inner or leaf collections, and explicit sibling fan-in.
- Optional `ForReturn.continue_condition` early-break behavior. `None` and `True` schedule
  the next iteration, and `False` finalizes the current loop context after collecting the current return.

## Architectural Direction

Use a bounded collection-based loop as the first durable primitive.

The `For` node should have one loop source:

- `collection: list[Any]`

Other iteration sources should be separate collection-producing nodes:

- `Range`, `RangeOfSize`, and `RandomRange` produce integer collections.
- `CollectionConcat` combines collections in left-to-right order.
- `CollectionZip` produces equal-length positional pairs.
- `CollectionCartesian` produces every combination of two collections, up to 100,000 pairs.

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
- a separate `ForContinue` control-flow node or general continue semantics
- parallel loop-body execution
- automatic inference of arbitrary loop body outputs

The first early-break contract is deliberately attached to `ForReturn`, where the current iteration already completes.
A separate `ForContinue` node remains a possible future extension if independent control-flow branches need to skip a
return or continue without producing an output item.

## Current Implementation Boundary

The current incremental implementation supports a bounded body path from iteration-scoped `For` outputs to one matching
`ForReturn`:

```text
For.iteration_output -> ForReturn.input
For.iteration_output -> BodyNode.input -> ForReturn.input
```

The runtime schedules the next `For` iteration when the matching `ForReturn` completes, carries `LoopState` forward, and
rematerializes the reachable body path for the next iteration. Final-scoped outputs release after the last matching
`ForReturn` completes, or after `ForReturn.continue_condition` is `False`.

The current body rematerializer copies edges whose source is the `For` node, another node in the loop body path, or an
already prepared node outside the body path. That supports shared configuration or prompt inputs:

```text
ExternalNode.output -> BodyNode.input
```

The external node must not be derived from an `Iterate`. An independent iterator feeding the body would create multiple
body returns for one `For` iteration, while the first implementation requires exactly one matching `ForReturn`.
Iterator-derived values must be collapsed as needed and then carried explicitly through the `For` inputs and iteration
outputs. Direct iterator-derived external body inputs are rejected until the runtime has a durable contract for mapping
multiple iteration dimensions.

### Durable Loop Linkage

`For` and `ForReturn` are associated by a required serialized `loop_linkage` edge. The edge is a control-flow
association, not a value connection:

```text
For.loop_linkage - - - - - - - - - - - - - - - - - > ForReturn.loop_linkage
For.item -> body path -> ForReturn.output
```

The edge is part of graph JSON and workflow JSON, so it survives save/load and execution resume. It is not inferred from
reachability, a process-local transient store, or a runtime-generated execution-node ID. The `For` output carries a
constant linkage marker so the prepared execution result remains schema-valid, but the marker is not consumed as an
ordinary data input by `ForReturn`.

Design note: `loop_linkage` is an explicit association edge rather than metadata on either invocation. This makes loop
ownership a first-class part of the serialized graph, lets the editor and backend validate the same relationship, and
keeps the association out of executable data flow while preserving it through save/load and execution resume.

Validation rules are shared by the backend and frontend:

- every `For` has exactly one outgoing `loop_linkage` edge;
- every `ForReturn` has exactly one incoming `loop_linkage` edge;
- the edge must connect `For.loop_linkage` directly to `ForReturn.loop_linkage`;
- connector nodes cannot be used for `loop_linkage`; connectors are re-pointable data-flow aliases, while loop
  ownership must remain a stable, unambiguous association between the two boundary nodes;
- a `For` or `ForReturn` cannot participate in a second linkage edge;
- removing either boundary removes the serialized edge, and replacing a boundary requires a new edge to the replacement;
- `For.collection`, `For.state`, `ForReturn.output`, and `ForReturn.state` each accept at most one incoming edge;
  malformed saved graphs with duplicate boundary inputs are rejected.

This slice establishes the serialized contract. Linked nested `For` boundaries are supported recursively when
each boundary has one direct child `For` or independent direct children joined by an explicit fan-in continuation. A child
final collection may feed the parent's matching `ForReturn` directly or through an ordinary outer continuation subgraph.
Sequential composition, mixed nested loop shapes, and implicit product or zip semantics remain rejected. A bounded internal `Iterate` is supported only when one matching `Collect`
collapses its item dimension before `ForReturn`; other internal iterator shapes remain rejected.

The first runtime consumer of the linkage is the body-path resolver used by materialization and empty-loop cleanup. A
`For` selects the reachable `ForReturn` named by its linkage edge. This separates runtime ownership lookup from
author-time validation and permits the recursive nested shape described below. Multiple nested levels use composite
execution contexts and independent output ownership. A supported continuation subgraph runs once per parent iteration
after one child finalizes, or after all independent sibling children finalize at the fan-in barrier; mixed nested loop
types remain rejected.

The supported nested `For` shape is:

```text
For.outer.item -> preparation -> For.inner.collection
For.inner.item -> inner body -> ForReturn.inner.output
For.inner.output_collection -> optional outer continuation -> ForReturn.outer.output
For.outer.state -> ForReturn.outer.state (optional)
```

The inner and outer boundaries must have distinct `loop_linkage` edges. The scheduler keeps both iteration
dimensions in execution paths, defers the outer continuation and `ForReturn` until the inner loop finalizes, and creates
one outer return per outer iteration. Continuation nodes may consume the inner final collection and values from the outer
iteration or its preparation path. Empty inner collections still produce one empty outer result. Nested `For` failure
stops the outer loop without releasing downstream final outputs.

An inner `ForReturn.state` may come from the inner `For.state` or from a state-producing node in the inner body. It may
not be sourced directly from the outer `For` or from outer preparation, because that would bypass the inner loop's state
boundary and make state ownership ambiguous.

The supported internal iterator extension has this shape:

```text
For.item -> optional body preparation -> Iterate.collection
Iterate.item -> body node(s) -> Collect.item
Collect.collection -> ForReturn.output
For.state -> ForReturn.state (optional)
```

There must be one internal `Iterate`, one `Collect`, exactly one item stream into that `Collect`, and a direct
`Collect.collection` to `ForReturn.output` connection. The `Collect` is the scope boundary: each outer `For` iteration
gets one collection and one `ForReturn`, even when the inner collection is empty. The inner execution paths include both
dimensions, such as `(outer_index, inner_index)`; the `Collect` and `ForReturn` use only the outer path.

An independent iterator feeding the loop body remains rejected. It would add an execution dimension that is not owned by
the `For`, while the supported internal iterator is explicitly collapsed before the return boundary.

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

The wrapper gives schema-facing code a stable type and leaves room for future metadata and validation.

### 2. For Node

The `For` node is the loop boundary.

Inputs:

- `collection: list[Any]`
- `state: LoopState | None = None`

Prepared execution nodes also carry a hidden scheduler-owned `index`. It is direct metadata, not a connectable input;
the scheduler copies it for each materialized iteration.

Association output:

- `loop_linkage: Any` (required association marker used only by the serialized linkage edge)

Per-iteration outputs:

- `item: Any | None` (null on the synthetic result for an empty collection)
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
item: Optional[Any] = OutputField(default=None, ..., loop_scope="iteration")
output_collection: list[Any] = OutputField(..., loop_scope="final")
```

The implemented schema uses `output_scope` metadata. This metadata is preserved through backend schema generation,
frontend type generation, and execution-graph materialization. Saved workflows preserve the invocation type and edge
field handles; when a workflow is loaded, the current invocation template resolves those handles to their output scopes.
A `For` node cannot be implemented as an ordinary invocation that only returns one flat output model.

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
- `continue_condition: bool | None = True`
- `loop_linkage: Any | None = None` (optional on the node schema so an editor node can be created before pairing;
  required as a graph connection to the matching `For`)

Outputs:

- `output: Any | None`
- `state: LoopState | None`

Semantics:

- `output` is appended to the final `For.output_collection` when present.
- `state` becomes the next iteration's state when present.
- If `state` is omitted, the previous state carries forward unchanged.
- `continue_condition` defaults to `True`; `None` also continues, while `False` finalizes the
  current loop context after recording the current return.

The loop should require exactly one matching body return node for each loop boundary. A nested shape may have multiple
reachable returns, but each `For`'s linkage must select exactly one return.
Default return behavior can be added later, but it would make the boundary harder to validate.

`ForReturn.output` and `For.output_collection` are convenience result plumbing, not required loop primitives. A body
that only needs a final accumulator can leave `output` disconnected and carry the accumulator through `state` instead.
For example, a per-iteration collection can be accumulated explicitly with `StateGet` -> `Collect` -> `StateSet`, then
returned through `ForReturn.state` and read from `For.final_state`. The missing collection key must be initialized with
an empty typed collection through `StateGet.default`. This keeps multiple evolving values together in `LoopState`, but
copies the growing collection through state on every iteration; use the built-in output channel when per-iteration
results only need to be collected as one final collection.

The state-accumulation shape is distinct from the scheduler-special `Iterate` -> body -> `Collect` -> `ForReturn`
shape. The iterator shape collapses an inner iterator dimension; the state-accumulation shape uses `Collect` inside the
body to append one value
to a state-held collection. `Collect` remains scheduler-managed in both shapes, and the state-accumulation wiring is
currently supported only as a simple `For` body path.

For the target implementation, the recommended body boundary is a boundary pair:

- `For` starts the body through its iteration-scoped outputs.
- `ForReturn` ends the body for one iteration.
- The loop body is the reachable subgraph from `For` iteration-scoped outputs to the matching `ForReturn`.

The `ForReturn` must be associated with a specific source `For`. Reachability alone is not sufficient once nested loops
or shared body paths are allowed, because the backend must know which return node closes which loop. The serialized
`loop_linkage` edge records that association directly. The runtime consumes it for recursive nested execution and
continues to reject mixed loop bodies and sibling shapes without an explicit fan-in.

This is simpler than a full visual subgraph while still giving the backend an explicit return boundary. Validation must
also reject loop-body paths that escape to after-loop nodes without passing through the matching `ForReturn`.

The current branch implements this reachable body-path subset plus linkage validation. The runtime supports recursively
linked inner `For` boundaries whose final collections feed their parent `ForReturn` directly or
through an ordinary continuation subgraph. Sibling loop branches may use explicit `CollectionConcat` or
`CollectionZip` or `CollectionCartesian` continuations; mixed loop types and implicit pairing remain future work.

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

For the bounded internal iterator extension:

```text
For[0].item -> Prepare[0] -> Iterate[0].collection
Iterate[0,0].item -> Body[0,0] -> Collect[0].item
Iterate[0,1].item -> Body[0,1] -> Collect[0].item
Collect[0].collection -> ForReturn[0].output
```

The next outer iteration uses a new outer context, for example `Iterate[1,0]`, `Iterate[1,1]`, `Collect[1]`, and
`ForReturn[1]`. The scheduler waits for every inner body execution before running the outer `Collect`, then waits for
that `ForReturn` before creating the next outer `For` iteration.

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
- `state_get` returns its configured `default`, or `None` when the key is absent and no default is supplied.
- `state_set` returns a new `LoopState` with one key updated.
- `state_merge` returns a new `LoopState` with multiple updates applied.

These helpers let workflows opt into state without making every loop body handle dictionaries manually.

`state_set.value` is an `AnyField` connection input. Connect `For.item` to store the current item, or connect any
other node output to store a computed value. It does not provide a generic literal editor; to store a constant, add
the appropriate typed value node (for example, an Integer or String node) and connect its output to `value`.

`state_merge.values` is also an `AnyField` connection input. Connect a node that outputs a dictionary of updates when
several state keys must be changed together.

`state_get.default` is an optional `AnyField` connection input used when its key is absent. For example, connect an
Integer node containing `0` to `default` to initialize a running sum on the first iteration. `state_get.value` then
provides the existing value or that fallback to the rest of the loop body or to a post-loop node.

## Execution Contract

### 1. Loop Source

The loop source is `For.collection`.

The collection must be available before the loop body can materialize.

If the collection is empty:

- no body iterations run
- final `output_collection` is empty
- final `state` is the provided initial state or an empty `LoopState`
- the synthetic `For` result has `item=None`, `index=-1`, and `total=0`; no iteration item is emitted

### 2. Initial State

If `For.state` is connected, the first iteration receives that state.

If `For.state` is not connected, the first iteration receives an empty `LoopState`.

The scheduler deep-copies the collection and state when it creates each prepared `For` iteration. Ordinary input values
are also deep-copied when transferred across execution edges; scheduler-managed `Iterate.collection` inputs are the
intentional exception because the iterator reads the source collection without duplicating it. The state helper nodes
deep-copy values when reading or updating state, so mutable values are not shared accidentally between iterations or
helper results.

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

`ForReturn.continue_condition` is optional. `None` and `True` schedule the next collection item when one exists. `False`
completes the current loop context immediately after the current output and state are recorded. Final outputs are
released normally, and downstream nodes receive only the items processed before the break. The condition is ordinary
invocation input, so connected values are evaluated for each rematerialized `ForReturn` execution and survive
serialization/resume.

If body execution fails, normal invocation failure behavior applies. No later iterations should be materialized, no
partial output collection should be exposed, and final-scoped outputs should remain unavailable.

### 5. Final Output

The `For` final output is available only after:

- every iteration has completed successfully, or
- `ForReturn.continue_condition` is `False` for a completed iteration

The final output contains:

- collected body output items in iteration order
- final loop state

When a visible `For` node is itself materialized under an outer iterator context, final output aggregation is scoped to
that parent context. Return values from the same source `ForReturn` in another outer iteration must not be mixed into the
current loop's `output_collection` or `final_state`.

Downstream nodes after the loop receive data through normal edges from the final-scoped outputs:

- `For.output_collection`
- `For.final_state`

Those downstream nodes become ready only after the final prepared execution node for every active parent context is
complete. The scheduler records completion independently for each parent context, then materializes after-loop nodes
for those contexts together. They should not depend on or see per-iteration prepared outputs directly unless they are
part of the loop body.

During incremental implementation, final-scoped `For` outputs may exist in the schema before the runtime final prepared
node exists. In that state, edges from `For.output_collection` and `For.final_state` must not be materialized from
per-iteration `For` execution nodes. They should remain blocked until the scheduler can create a final loop execution
surface after all iterations complete.

### 6. Cancellation And Partial Results

If execution is cancelled or fails before the final loop output is produced, partially aggregated outputs must remain
internal execution state. Downstream after-loop nodes should not observe partial `output_collection` or `final_state`
values.

This applies even when earlier iterations completed successfully. A failed body node or failed `ForReturn` terminates
the execution state without releasing the loop's final-scoped outputs. An empty collection is different: it is a
successful loop completion with no body iterations, so it releases an empty `output_collection` and the hydrated initial
state. When `For` is under an outer iterator, each existing parent context finalizes independently, but after-loop nodes
wait until all active parent contexts have final outputs. If the outer iterator has no contexts, the inner `For` produces
no per-context final output and downstream collection behavior remains empty.

### 7. Ordering

Loop iterations are currently scheduled sequentially, including stateless loops.

Parallel loop execution is not implemented.

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

The current branch persists this through existing `GraphExecutionState` fields: the materialized execution graph,
executed node ids, results, prepared-source mappings, source-prepared mappings, indegrees, and finalized loop source
contexts. A finalized context is keyed by the `For` source node and its parent iteration path. Empty-loop final outputs
use the parent path directly; they do not create a synthetic `-1` path component. Runtime-only queues and prepared
metadata are rebuilt during model rehydration. Tests cover resuming a stateful `For` after the prepared `For` node,
after a body state helper, after `ForReturn`, and across parent iterator contexts.

### 9. Caching

Invocation cache behavior must not collapse distinct loop iterations incorrectly.

Cache keys for body nodes must account for normal prepared input values. If a node depends on loop state, the explicit
state input should participate in its normal invocation value hash.

The `For` boundary itself is scheduler-special, but rematerialized body nodes are ordinary invocations after their inputs
are prepared. A stateless body node can therefore reuse cache entries when different loop executions produce the same
prepared body inputs. For example, loops over `[0, 1, 4, 5]` and `[0, 2, 5, 7]` may reuse body-node cache entries for
items `0` and `5` if the body node depends only on the item and matching external configuration. If the body also
depends on `index`, `total`, loop `state`, or other inputs, those values must participate in the normal cache key and
can prevent reuse.

If a future feature rematerializes stateful nodes outside iterator ancestry, that behavior must either bypass cache or
include the relevant iteration context in the cache key.

## Validation Contract

Graph validation should reject ambiguous loop structures before runtime.

Potential validation rules:

- `For.collection` must be connected or provided as a direct value.
- `For.state`, when connected, must be compatible with `LoopState`.
- Edges from iteration-scoped `For` outputs must be treated as loop-body edges.
- Edges from final-scoped `For` outputs must be treated as after-loop edges.
- Output-scope metadata must survive backend schema generation, frontend type generation, and graph preparation. Saved
  workflows must preserve the node type and field handles needed to resolve that metadata from the current template.
- Each loop boundary must expose exactly one matching body return node. Nested boundaries may recurse. One direct child
  `For` may close the parent directly or through an ordinary continuation; multiple independent direct children must all
  feed an ordinary parent-scoped continuation that acts as an explicit fan-in barrier.
- A body return's `state` input must be compatible with `LoopState`.
- The author-time graph must remain acyclic.
- Nodes inside the loop body must not feed after-loop nodes directly.
- Linked nested `For` boundaries are valid recursively only in the inner-final-collection shape described above.
  The continuation subgraph must be reachable from every direct child `output_collection`, must terminate at the parent
  `ForReturn`, and must not contain another `For`, `Iterate`, or `ForReturn`. Sibling children do not imply zip or
  Cartesian semantics; an ordinary fan-in node must define how their final collections are combined.
- An internal `Iterate` is valid only in the bounded `Iterate -> body -> Collect -> ForReturn` shape described above.
- Other internal `Iterate` shapes, including multiple internal iterators or an iterator that escapes through another
  output, must be rejected.
- Iterator-derived external body inputs must be rejected until multiple iteration dimensions have an explicit body
  mapping contract.

First implementation recommendation:

- Use a boundary pair rather than a full visual subgraph.
- The simple body is reachable from iteration-scoped `For` outputs and terminates at one `ForReturn`. The recursive
  nested shape adds one inner boundary at a time and terminates each parent body at its own matching `ForReturn`.
- Continuation paths that escape the parent body before `ForReturn` should be rejected. A continuation is evaluated once
  per parent iteration after the child loop finalizes; it must not be treated as a second iteration dimension.

Resolved design question:

- The durable endpoint association is a required serialized `loop_linkage` edge from `For` to `ForReturn`. It is a
  direct relationship between boundary nodes, not a data-flow edge. Missing, stale, duplicate, or mismatched linkage
  is invalid; deleting either endpoint removes the edge, and a replacement boundary must be linked explicitly.

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

The current frontend connection validator stages each proposed edge, resolves scoped outputs through connector chains,
and checks every scoped loop source in the staged graph. It rejects a connection when any final-scoped output would
target a node reachable from an iteration-scoped output. The check is independent of connection order: adding a final
edge to an existing body, adding an iteration edge that would absorb an existing final target, and extending the body
through an ordinary node edge are all rejected when they create scope overlap.

The ordinary invocation renderer now groups scoped fields under localized `Iteration Outputs` and `Final Outputs`
headings. Nodes without scoped outputs keep the existing flat output rendering.

The editor now also draws a non-interactive dashed boundary around the reachable path from each `For` iteration output
to the `ForReturn` named by its linkage edge. The overlay labels incomplete, invalid, duplicate, ambiguous, empty, and
orphaned boundary states. The linkage edge is rendered as a dashed green association and is not included in executable
graph paths. The overlay is a rendering affordance only: it does not add nodes or infer associations. Replacing either
boundary removes the existing edge; connecting the replacement creates a new association.

When an iteration-scoped output connection is dropped on empty canvas, the add-node picker prioritizes `ForReturn`,
expands its category, and preserves that priority while searching. Selecting it uses the existing valid-connection
candidate logic to wire the iteration value to the compatible `ForReturn` input. This is a narrow boundary-discovery
affordance, not yet a structured visual loop-body editor.

This local guard intentionally does not require a complete body while the user is editing. Matching `ForReturn`
ownership, unterminated body paths, nested loops, internal `Iterate` nodes, and iterator-derived external inputs remain
whole-graph validation concerns enforced by the backend.

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
interactive UI may turn the current read-only boundary into a richer loop region around the reachable body nodes between
`For` and `ForReturn`.

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

### Bounded Nested Iterate Body

The first nested-loop extension supports a bounded inner `Iterate` whose results are collapsed before the outer body
returns:

```text
For.iteration_output -> Iterate -> Action -> Collect -> ForReturn
```

`Collect` is the inner iteration boundary in this shape. It must collapse only the inner `Iterate` dimension and emit
exactly one collection into `ForReturn` for each outer `For` iteration. The outer loop must not advance until that
collection and the matching `ForReturn` complete.

Supporting this shape requires:

- rematerializing the inner `Iterate`, its descendants, and its matching `Collect` under the current prepared `For`
  context
- preserving a composite iteration path such as `(for_index, iterate_index)`
- ensuring `Collect` collapses the inner dimension without mixing values from other `For` iterations
- producing exactly one matching `ForReturn` completion per outer iteration
- persisting and restoring nested prepared-node and collection state
- stopping both inner and outer scheduling on cancellation or failure without releasing partial final outputs

This bounded shape is implemented. Multiple internal iterators, an internal iterator that escapes through another
output, iterator-derived external inputs, and a per-item predicate connected directly to
`ForReturn.continue_condition` remain rejected. The latter would produce multiple condition values for one outer
iteration; a future extension must define an explicit scalar aggregation boundary first.

This extension must remain distinct from an independent external `Iterate` feeding a body node. The external shape has
no explicit rule for product, zip, or state-lane semantics and should remain rejected until such a contract is designed.

### Recursive Nested For Body

The nested `For` extension supports complete linked inner `For` boundaries recursively inside an outer `For`
body. Each boundary has one direct child loop or independent direct children joined by an ordinary continuation subgraph.
A child final output may close the parent directly or pass through that continuation:

```text
OuterFor.iteration_output -> InnerFor.collection
InnerFor.iteration_output -> InnerAction -> InnerForReturn
InnerFor.output_collection -> OuterContinuation -> OuterForReturn
```

For independent sibling children, every child final collection must feed the same parent-scoped fan-in continuation:

```text
OuterFor.item -> FirstFor.collection
OuterFor.item -> SecondFor.collection
FirstFor.output_collection  -> FanIn.first
SecondFor.output_collection -> FanIn.second
FanIn.output -> OuterForReturn.output
```

The fan-in node defines how the collections are combined. The scheduler supplies no implicit sequential, zip, or
Cartesian pairing. These semantics belong to ordinary collection operations, which can be connected as explicit
parent-scoped continuations.

### Explicit Collection Fan-In Operations

Use `CollectionConcat` when the two collections represent consecutive phases or sources and every item from the first
must appear before every item from the second. It preserves each input's order and does not align items by position.
Unequal lengths are expected and empty inputs are valid.

Use `CollectionZip` when the two collections represent corresponding records, such as an image collection and a
same-length collection of per-image parameters. It emits one pair for each position, preserving positional order. The
inputs must have equal lengths; a mismatch raises an error instead of silently truncating one side or inventing padding
values. Empty collections are valid when both inputs are empty.

Use `CollectionCartesian` for combinations rather than correspondence. It emits one pair for every combination of one
item from each input in left-major, right-minor order, so unequal lengths are expected and an empty input produces no
pairs. Use it when every item from one collection must be combined with every item from the other, not when items are
meant to be matched by position. The node rejects products larger than 100,000 pairs before allocation and accepts a
product of exactly 100,000 pairs.

All three operations are explicit ordinary nodes. None changes `For` scheduling, creates implicit loop dimensions, or
assigns meaning to sibling branches beyond the operation's documented collection semantics.

The inner loop must finalize before the outer continuation and body return execute. Its final outputs are ordinary body
data in the outer loop, so one completed inner loop produces exactly one matching `OuterForReturn` completion for the
current outer iteration. Continuation nodes can also consume outer iteration or preparation values, but they execute once
at the outer context rather than once per inner item.

An early break on an inner `ForReturn` finalizes only that inner loop context; the outer continuation still receives the
partial inner collection and the outer loop can continue. An early break on the outer `ForReturn` finalizes the current
outer context and prevents later outer iterations.

Supporting this shape requires:

- a durable `loop_linkage` edge that associates each `ForReturn` with exactly one `For`, without relying on ambiguous
  reachability
- a composite execution context that distinguishes the outer iteration, inner loop instance, and inner iteration
- independent output aggregation for every inner loop instance
- separate outer and inner state lanes, with state crossing a loop boundary only through explicit connections
- blocking the outer continuation until the inner loop finalizes successfully
- persisting and restoring both loop boundaries and their prepared execution state
- propagating inner cancellation or failure to the owning outer iteration without releasing partial inner or outer
  final outputs

This recursive shape is implemented and tested, including three nested boundaries, empty inner collections, an outer
continuation after an inner final output, and independent sibling children joined by one explicit fan-in continuation.
Sibling children finalize independently under the same parent iteration; the fan-in continuation runs once after all of
them finalize. Implicit sequential, zip, or Cartesian composition and mixed nested `Iterate`/`For` shapes remain
rejected. They must not be approximated by allowing reachability-inferred loop boundaries to share body or return nodes.

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
- empty collection preserves initial state supplied by a connected input
- mixed empty and nonempty parent iterator contexts both finalize in their own scopes
- an empty parent iterator completes downstream collectors without creating a synthetic inner context
- collection items are emitted in order
- index and total are correct for every iteration
- body outputs are collected in iteration order
- final-scoped outputs release after-loop nodes only after all required iteration returns complete
- iteration-scoped outputs are duplicated only into matching loop-body iteration contexts
- initial state reaches the first iteration
- returned state reaches the next iteration
- omitted returned state carries previous state forward
- final state is the last returned state
- `ForReturn.continue_condition` continues by default, breaks after the current return when false, and evaluates a
  connected predicate again for each rematerialized iteration
- early break preserves returned state and final output release across serialization/resume, including nested inner and
  outer loop contexts
- body failure stops later iterations
- cancellation or failure does not expose partial final outputs to after-loop nodes
- serialized `GraphExecutionState` can resume a partially completed loop
- cache does not collapse distinct stateful iterations
- the supported linked nested `For` shape completes nested contexts independently, including empty inner and
  leaf collections
- recursive nested `For` boundaries are accepted when each boundary has one direct child or explicit sibling fan-in and
  any post-child continuation is ordinary parent-scoped work; mixed nested loop shapes remain rejected
- runtime body-path resolution selects the matching `ForReturn` through its durable `loop_linkage` edge
- body paths that feed after-loop nodes directly are rejected
- nested `ForReturn.continue_condition` inputs are accepted only from the current nested body or parent-scoped
  continuation and reject external scopes that cannot be rematerialized
- nested final output can traverse an ordinary parent-scoped continuation before `ForReturn`, including empty child loops
- `CollectionConcat` combines sibling final collections in deterministic left-to-right order
- `CollectionZip` combines equal-length sibling final collections into deterministic positional pairs and rejects length mismatches
- `CollectionCartesian` combines sibling final collections in deterministic left-major, right-minor order and accepts
  unequal lengths
- saved workflow JSON preserves the loop node types and field handles used to resolve output-scope metadata

Frontend tests should cover:

- graph validation for loop source and state wiring
- graph validation for iteration-scoped vs final-scoped output edges
- workflow serialization and deserialization of loop nodes
- deserialized loop nodes resolve output-scope metadata from the current invocation templates
- type compatibility for `LoopState`
- visual grouping of iteration outputs and final outputs
- editor handling for body return nodes
- mounted `happy-dom` coverage for the visible loop-body boundary label/status and `ForReturn` picker wiring

### Current Coverage

Backend unit tests currently cover the invocation contracts, durable loop-linkage validation, linkage-aware runtime
body-path resolution, and graph round-trip,
state helper copy semantics, graph-boundary validation,
sequential materialization, state carry, final output release, empty collections, failure handling, serialization and
resume, parent iterator scoping, cache-key behavior, and release of completed iteration collection copies.
`DefaultSessionRunner` integration tests cover successful queue completion and session persistence, cancellation between
iterations without releasing final outputs, and iteration-body exceptions without scheduling later iterations or
after-loop nodes. Nested `Iterate` runner tests cover inner cancellation and body exceptions without releasing outer
final outputs. Threaded `DefaultSessionProcessor` tests exercise the same success, cancellation, and failure paths;
the cancellation path sends a real `QueueItemStatusChangedEvent` through the processor handler using a synchronized
queue harness. SQLite queue tests persist a partial stateful loop, reload its prepared metadata, complete only the
remaining iterations, and persist the final collection and state. Schema generation verifies that moving the invocation
definitions does not change their serialized API contracts.
The SQLite queue round-trip also covers a bounded nested `For` checkpoint taken after the first outer iteration's inner
loop completes, preserving the completed inner context while the remaining outer and inner iterations resume without replay.
The production-style processor integration test uses the actual SQLite queue lifecycle and registered event bus with a
bounded nested `Iterate` inside `For` and a bounded nested `For`, covering success, cancellation, and body-failure
cleanup for both shapes.
Nested `For` runner tests cover independent outer contexts, empty inner collections, explicit outer state wiring, inner
cancellation, and inner-body failure without releasing final outputs.

Frontend unit tests cover `For` and `ForReturn` graph/workflow round trips, durable loop-linkage validation, resolution of their output scopes from the
current templates, and `LoopState` connection-type compatibility. Frontend connection tests cover iteration/final scope
overlap across incremental connection orders, through ordinary body extensions, body descendants, and connector nodes.
Output row-model and renderer tests cover flat rendering for ordinary nodes and distinct localized iteration/final
sections for scoped nodes. Add-node picker tests cover contextual `ForReturn` priority, exact-search ordering, and
compatible input auto-wiring through the shared connection helper. Enqueue-time graph validation covers return
ownership, unterminated paths, nested loops, the supported bounded internal `Iterate` shape and rejected variants,
iterator-derived external inputs, final outputs feeding the body, and body outputs escaping before `ForReturn`.
Backend and frontend validation tests accept deeper nested `For` loops, explicit sibling fan-in, and reject mixed nested
`For`/`Iterate` bodies, nested early-break predicate scope, sibling children without complete fan-in, and a `ForReturn`
shared by multiple loops. Schema/template tests cover the versioned `continue_condition` input and its default-continue
editor behavior.
Mounted `happy-dom` tests cover the visible loop-body boundary label/status and selecting `ForReturn` from a pending
`For.item` connection, including the dashed linkage edge and automatic edge creation. These tests reuse the
existing `happy-dom` dependency; this branch adds no browser-test dependencies or configuration. Unit tests cover
contextual `ForReturn` discovery and connection wiring.
Collection operation tests cover sequential concatenation, strict positional zipping, Cartesian products, empty inputs,
input immutability, and zip length mismatches.

## Open Questions

Answered branch-local decisions:

- The first implementation uses explicit `for_return`.
- `ForReturn.output=None` is omitted from `For.output_collection`.
- Loop output scope is invocation output field metadata and is preserved through backend schema and frontend type
  generation. Saved workflows preserve node types and field handles, then resolve scope from the current templates when
  loaded.
- Durable loop linkage is the required serialized `loop_linkage` edge from `For` to `ForReturn`. It is persisted with
  the workflow graph and is required for every loop boundary; it is not an ordinary executable data-flow edge.
- A nested child's final `output_collection` may feed an ordinary parent-scoped continuation subgraph before the matching
  parent `ForReturn`. The continuation is materialized once at the parent iteration path after child finalization; it may
  consume child final output plus parent iteration/preparation inputs. Independent sibling loops are supported only when
  every child final collection feeds one explicit parent-scoped fan-in continuation, which executes once after all
  siblings finalize; no zip, Cartesian, or implicit sequential semantics are assigned.
- `CollectionConcat` is the explicit sequential operation: it preserves left-to-right collection order and accepts
  unequal lengths.
- `CollectionZip` is the explicit positional operation: it requires equal lengths and emits JSON-friendly pairs;
  unequal lengths fail rather than truncate or pad.
- `CollectionCartesian` is the explicit all-combinations operation. Unequal lengths are valid, empty input yields no
  pairs, and pair ordering is deterministic left-major, right-minor without changing scheduler behavior.
- Early break uses optional `ForReturn.continue_condition`: `None` and `True` continue, while `False` finalizes the
  current loop context. A future `ForContinue` node may provide an independent control-flow form if needed, but it is
  not required for this contract.
- `LoopState`, `For`, `ForReturn`, and the state helper nodes are defined in the dedicated `invocations.loops` module.
  Scheduler, materialization, and graph-boundary validation remain in the graph execution service.

## Incremental Implementation Plan

1. Add `LoopState` schema and state helper nodes.
2. Add `For` and `ForReturn` invocation definitions with scoped output metadata but without runtime behavior beyond
   validation/schema.
3. Preserve output-scope metadata through saved workflows, backend schemas, frontend types, and graph preparation.
4. Add graph validation for the bounded collection-based loop shape and matching `ForReturn` body boundary.
5. Reject unsupported nested loops and body paths that escape directly to after-loop nodes; add durable endpoint linkage
   edges for nested/shared runtime paths.
6. Extend `GraphExecutionState` materialization to create one iteration context at a time.
7. Route iteration-scoped outputs into body execution nodes and final-scoped outputs into after-loop nodes.
8. Carry explicit returned state into the next iteration.
9. Aggregate final output collection and final state.
10. Add serialization/resume tests.
11. Add editor affordances after the backend contract is stable.
12. Support recursively linked nested `For` boundaries with independent inner aggregation and deferred outer
    return materialization.
13. Define and implement a deterministic nested final-output continuation contract.
14. Define and implement sibling nested-body contracts with an explicit fan-in barrier; leave sequential, zip, and
    Cartesian composition to ordinary collection operations.
15. Add the first explicit sibling collection operation, `CollectionConcat`, with deterministic left-to-right semantics.
16. Add explicit positional sibling pairing with `CollectionZip`, including a strict equal-length contract.
17. Add explicit all-combinations sibling pairing with `CollectionCartesian`.
18. Add an explicit `ForReturn.continue_condition` early-break contract and verify finalization, state, resume, and
    nested-context cleanup.

Steps 1 through 18 are complete for the current recursive body-path contract. Step 11 now includes output grouping,
contextual `ForReturn` discovery/wiring, a structured visual body boundary, and mounted `happy-dom` interaction
coverage. Full browser geometry, drag, and zoom behavior remains outside this test environment. Final cleanup is
complete: no branch-specific temporary browser-test dependencies or configuration remain, and the mounted tests use
the existing `happy-dom` dependency.

The durable endpoint linkage slice, bounded internal `Iterate` slice, recursive linked nested `For` slice,
deterministic nested final-output continuation slice, explicit sibling fan-in slice, positional `CollectionZip` slice,
and `CollectionCartesian` slice are implemented. Nested execution
uses explicit composite paths, independent inner aggregation, deferred outer returns, parent-scoped continuation
materialization, empty-group handling, failure cleanup, and durable source/execution mappings. Sequential sibling
composition is available through `CollectionConcat`, positional pairing through `CollectionZip`, and all-combinations
pairing through `CollectionCartesian`. Early break is available through `ForReturn.continue_condition`; parallel
stateless loops and richer collection producers remain later work.

## Next Development Slice

The final cleanup slice is complete. No additional `For` implementation slice is required before PR validation. The
next code work after this branch is parallel stateless loops and richer collection producers; those remain separate
architecture work and are not started here.
