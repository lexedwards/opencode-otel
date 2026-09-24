# Agent telemetry architecture

```text
OpenCode v2 event stream(s) ──> per-location subscription ──> shared execution coordinator
OpenCode tool hooks ────────────────────────────────────────────┤
                                    │      execution keyed by session, tool keyed by call ID
                                    │                         │
                                    └───────────────> private tracer + meter providers
                                                          │              │
                                             bounded span batch    periodic metrics
                                                          │              │
                                                 OTLP HTTP/protobuf exporters
```

The first plugin instance creates a single process-local pipeline. Each location subscribes to its events and filters by directory internally; only opaque project and workspace IDs become span attributes. Coordinator deduplication handles overlapping subscriptions. A terminal execution event ends its root span and records duration in seconds, including when tracing is sampled away. Tool hooks create direct child spans with explicit parent contexts, and record duration and per-invocation call counts; no ambient context or raw tool payload is used. Unknown failure messages and stack traces are never exported. Bounded active-execution and active-tool maps and the OpenTelemetry batch processor cap memory use; later work adds expiration of abandoned operations.

Shutdown aborts each instance's subscription; only the last instance shuts down the private providers, with a five-second wait limit. No global provider is registered. The architecture has only in-memory unit verification, not Collector interoperability or launched-OpenCode verification.
