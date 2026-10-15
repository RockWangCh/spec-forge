# Event Log and Task Envelope

This repo now defines two protocol-level artifacts to support a more observable and recoverable multi-agent runtime:

- `specs/task-envelope.schema.json` describes a normalized task message passed to an agent or orchestrator.
- `specs/event-log.schema.json` describes execution events that can be appended to a task journal for replay, debugging, and auditing.

## Why this matters

The current spec-forge runtime is already strong in orchestration, state persistence, retries, and verification. However, multi-agent systems need a standardized way to:

- uniquely identify a task and trace its execution
- record decisions and external tool calls
- replay or reconstruct what happened after a failure
- support permission/capability checks across skills and agents

These schemas make the runtime more portable, observable, and production-ready.

## TaskEnvelope

A TaskEnvelope is a normalized message describing a work item to be executed. It includes:

- task_id and trace_id
- parent_task_id for nesting and root-cause analysis
- ts for time provenance
- scope (global / job / verification / other)
- agent
- input and metadata
- required permissions / capabilities / priority

## EventLog

Each task can emit structured events such as:

- dispatch
- start
- tool_call
- tool_result
- update
- decision
- complete
- fail
- retry

Events are persisted in JSON Lines (`events.log`) and can be replayed later to produce a decision DAG or audit trail.

## Integration plan

A future step will wire these schemas into the runtime:

- `scheduler.cjs` emits dispatch/retry events
- `cli.cjs update` emits update/decision/complete events
- `subagent-handler.cjs` emits tool_call/tool_result/fail events
- replay tools can read `specs/{TS}/events.log` and visualize execution

This lays the groundwork for deterministic debugging, higher trust, and better multi-agent observability.
