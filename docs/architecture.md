# Agent telemetry architecture

```text
OpenCode v2 event stream(s) ──> per-location subscription ──> shared execution coordinator
OpenCode tool hooks ────────────────────────────────────────────┤
OpenCode step/retry events ──────────────────────────────────────┤
OpenCode permission events ──────────────────────────────────────┤
OpenCode session creation/fork events ───────────────────────────┤
                                    │      execution keyed by session, tool keyed by call ID,
                                    │      model keyed by assistant message ID
                                    │                         │
                                    └───────────────> private tracer + meter providers
                                                          │              │
                                             bounded span batch    periodic metrics
                                                          │              │
                                                 OTLP HTTP/protobuf exporters
```

The first plugin instance creates a single process-local pipeline. Each location subscribes to its events and filters by directory internally; only opaque project and workspace IDs become span attributes. Coordinator deduplication handles overlapping subscriptions. A terminal execution event ends its root span and records duration in seconds, including when tracing is sampled away. Tool, primary model, and active-compaction operations create direct child spans with explicit parent contexts; model retry events enrich the same logical span. Manual compaction outside an execution starts its own trace. Child/fork executions start independent traces with a Link to the parent execution context when available:

```text
Trace A: invoke_agent ──┬── chat (primary)
                        ├── execute_tool
                        └── chat (compaction)
          ↑ Link from Trace B: invoke_agent (child/fork)
Trace C: chat (standalone manual compaction)
```

Permission requests and decisions add bounded events to the agent root and low-cardinality metrics. No ambient context or raw payload is used. Unknown failure messages and stack traces are never exported. Active executions, model calls, compactions, relation hints, and buffered terminal metadata are bounded and expire after 24 hours by default; `executionExpiryMillis` can override this with a positive integer number of milliseconds. A one-minute-or-shorter unref'd cleanup timer ends stale spans as abandoned and emits a rate-limited content-free diagnostic. Short fixed operation timeouts are avoided so long-running sessions are not truncated. The OpenTelemetry batch processor also caps queued spans.

Shutdown aborts each instance's subscription; only the last instance shuts down the private providers, with a five-second wait limit. No global provider is registered. The architecture has only in-memory unit verification, not Collector interoperability or launched-OpenCode verification.
