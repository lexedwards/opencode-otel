# v1 telemetry inventory

Private trace and metric providers; **no OpenTelemetry logs or GenAI log events**. Content is opt-in, span-only. Metrics contain no prompts, model IDs, paths, commands, permission resources, or arbitrary metadata.

| Trace operation | Shape | Attributes/events |
| --- | --- | --- |
| Agent execution | `invoke_agent` INTERNAL root | Opaque project/workspace span attributes, bounded outcome/error type and duration. Permission asks/replies are root span events with bounded action/reply values. |
| Tool execution | `execute_tool` INTERNAL child | Status, bounded error type; independently opted-in arguments, results, message and stack. |
| Primary model | `chat <model>` CLIENT child | Provider/model, usage and retry; independently opted-in input/output/instructions/tool definitions and errors. |
| Compaction | `chat` CLIENT child when execution active; standalone root otherwise | Same model metrics; only completed summary may be captured. |
| Child/fork execution | new `invoke_agent` root | Link to active parent context when known; distinct trace ID. |

| Metric | Unit | Purpose |
| --- | --- | --- |
| `gen_ai.invoke_agent.duration` | s | Agent execution latency. |
| `gen_ai.execute_tool.duration` | s | Tool latency. |
| `gen_ai.invoke_agent.tool_calls` | {call} | Tool calls per execution. |
| `gen_ai.client.operation.duration` | s | Model/compaction operation latency. |
| `gen_ai.client.operation.time_to_first_chunk` | s | First durable streamed response, when observed. |
| `gen_ai.client.token.usage` | {token} | Provider-reported input/output token usage. |
| `gen_ai.invoke_agent.inference_calls` | {call} | Completed inference calls per execution. |
| `opencode.gen_ai.cost` | USD | Provider-reported cost. |
| `opencode.gen_ai.retry.count` | {retry} | Scheduled retries. |
| `opencode.permission.request.count` | {request} | Permission demand. |
| `opencode.permission.reply.count` | {reply} | Once/always/reject decisions. |
| `opencode.permission.wait.duration` | s | Nonnegative request-to-reply wait. |

- No model telemetry for title generation or transient `session.generate`.
- No `gen_ai.client.operation.time_per_output_chunk`: text deltas do not reliably map to provider chunks.
- Unknown provider IDs can add cardinality; normalize them with `providerNames`.

See [model conventions](model-telemetry.md), [permission policy](permission-telemetry.md), and [content capture](content-capture.md).
