# Operator reference

## Activation

| Endpoint | Signals | Path behavior |
| --- | --- | --- |
| None | Inactive; one informational diagnostic | No localhost fallback |
| `endpoint` | Traces and metrics | Generic HTTP endpoint adds `/v1/traces` and `/v1/metrics` |
| `traces.endpoint` / `metrics.endpoint` | Only the configured signal | Complete HTTP URL; gRPC host and port, no path |

Per-field precedence: **signal option → generic option → signal OTLP environment → generic OTLP environment → default**. Headers merge case-insensitively; specific values override generic ones. Invalid settings disable the affected signal with a content-free diagnostic. The first active process-wide configuration wins; restart OpenCode to change it. Failed exporter setup does not switch protocols.

## Transport and security

| Option | Default | Notes |
| --- | --- | --- |
| `protocol` | `http/protobuf` | Also `http/json`; `grpc` is experimental under Bun. Choose per signal. |
| `timeoutMillis` | 10,000 ms | Positive integer; standard `OTEL_EXPORTER_OTLP_*_TIMEOUT`. |
| `compression` | `none` | `none` or `gzip`; standard `OTEL_EXPORTER_OTLP_*_COMPRESSION`. |
| `headers` | Empty | Plugin values use `{env:NAME}`. Standard OTLP headers use comma-separated `key=percent-encoded-value`. |
| `certificate`, `clientCertificate`, `clientKey` | Unset | Plugin references resolve to PEM **contents**. Standard OTLP variables point to PEM **files**. Client cert and key must be paired; TLS settings on `http://` are rejected. |

See [HTTP receiver and TLS examples](http-collector.md) or [experimental gRPC setup](grpc-collector.md). No Collector or backend is bundled.

## Providers and timing

- Private SDK resources: `service.name=opencode`, `service.version=<running OpenCode version>`, process-scoped `service.instance.id`. Nothing is registered globally.
- `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` affect traces, not metrics; metrics continue when spans are unsampled.

| Option | Environment | Default |
| --- | --- | --- |
| `traces.batchQueueSize` | `OTEL_BSP_MAX_QUEUE_SIZE` | 2048 |
| `traces.batchMaxSize` | `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | 512 |
| `traces.batchDelayMillis` | `OTEL_BSP_SCHEDULE_DELAY` | 5000 ms |
| `traces.batchTimeoutMillis` | `OTEL_BSP_EXPORT_TIMEOUT` | 30000 ms |
| `metrics.exportIntervalMillis` | `OTEL_METRIC_EXPORT_INTERVAL` | 60000 ms |
| `metrics.metricTimeoutMillis` | `OTEL_METRIC_EXPORT_TIMEOUT` | 30000 ms |

Values must be positive integers; batch size cannot exceed queue size. `executionExpiryMillis` defaults to 24 hours; stale spans end as abandoned. Exporter shutdown has a five-second limit. `providerNames` normalizes provider IDs on spans and metrics; keep names low-cardinality. Project/workspace IDs are bounded span attributes only.

## Privacy

| Setting | Default | Effect |
| --- | --- | --- |
| `capture.inputMessages`, `outputMessages`, `systemInstructions`, `toolDefinitions` | Off | Enable separately; `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` enables these four unless overridden. |
| `capture.toolArguments`, `toolResults`, `errorMessages`, `stackTraces` | Off | Separate opt-ins; unaffected by the message-content umbrella. |
| `capture.redactKeys`, `redactPatterns` | Empty | Add property-name and text regex matches to built-in credential redaction. |
| `propagateTraceContext` | `false` | Add W3C context to supported provider requests. Can expose trace IDs and break request signatures. |

Redaction precedes the **4 KiB text** and **32 KiB attribute** limits. Oldest complete input messages drop first; inline binary is omitted, while external URI/file metadata may be retained. Compaction can capture its completed summary, never an incomplete input transcript. See [content capture](content-capture.md) and [propagation risks](provider-propagation.md). No OpenTelemetry logs or GenAI log events are emitted.
