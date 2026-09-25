# Model telemetry

## Spans

| Operation | Span | Parent | Captured content |
| --- | --- | --- | --- |
| Primary model step | `chat <model-id>` CLIENT | `invoke_agent` | Absent unless [opted in](content-capture.md). |
| Active compaction | `chat` CLIENT | `invoke_agent` | Only completed summary, if output capture enabled. |
| Manual compaction | `chat` CLIENT | Separate trace | Same summary rule. |
| Title / transient `session.generate` | None | — | None. |

All model operations use `gen_ai.operation.name=chat`. The model ID is a span attribute, never a metric dimension. Raw provider state is not captured. The vocabulary is pinned in [ADR 005](adrs/005-model-semantic-conventions.md); no GenAI schema URL is attached.

## Metrics

- `gen_ai.client.operation.duration`: step dispatch through completion, including retries (seconds).
- `gen_ai.client.operation.time_to_first_chunk`: first durable streamed event, when available (seconds).
- `gen_ai.client.token.usage`: provider-reported input + cache read + cache write; output reported separately.
- `gen_ai.invoke_agent.inference_calls`: completed calls per execution, including failures.
- `opencode.gen_ai.cost`: reported USD cost; `opencode.gen_ai.retry.count`: scheduled retries.

Time-to-first-chunk, inference calls, cost, and retry metrics are provisional extensions to the pinned vocabulary. `gen_ai.client.operation.time_per_output_chunk` is **not** emitted: OpenCode text deltas do not reliably identify provider chunks. Abandoned steps end with their agent execution without invented usage or cost.

Metric dimensions: operation, mapped provider, token type where applicable, and bounded error type. Known provider mappings include `google-vertex` → `gcp.vertex_ai`, `google` → `gcp.gemini`, `amazon-bedrock` → `aws.bedrock`, `azure` → `azure.ai.openai`, `mistral` → `mistral_ai`. Unknown IDs remain unchanged unless set in `providerNames`; custom IDs can add cardinality.

Verified with in-memory unit tests; no launched OpenCode or Collector interoperability claim.
