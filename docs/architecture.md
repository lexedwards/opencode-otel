# Agent telemetry architecture

```text
OpenCode v2 event stream(s) ──> per-location subscription ──> shared execution coordinator
OpenCode tool hooks ────────────────────────────────────────────┤
OpenCode step/retry events ──────────────────────────────────────┤
                                    │      execution keyed by session, tool keyed by call ID,
                                    │      model keyed by assistant message ID
                                    │                         │
                                    └───────────────> private tracer + meter providers
                                                          │              │
                                             bounded span batch    periodic metrics
                                                          │              │
                                                 OTLP HTTP/protobuf exporters
```

The first plugin instance creates a single process-local pipeline. Each location subscribes to its events and filters by directory internally; only opaque project and workspace IDs become span attributes. Coordinator deduplication handles overlapping subscriptions. A terminal execution event ends its root span and records duration in seconds, including when tracing is sampled away. Tool and model operations create direct child spans with explicit parent contexts; model retry events enrich the same logical span. No ambient context or raw payload is used. Unknown failure messages and stack traces are never exported. Bounded active-execution, active-tool and active-model maps and the OpenTelemetry batch processor cap memory use; later work adds expiration of abandoned operations.

Shutdown aborts each instance's subscription; only the last instance shuts down the private providers, with a five-second wait limit. No global provider is registered. The architecture has only in-memory unit verification, not Collector interoperability or launched-OpenCode verification.
