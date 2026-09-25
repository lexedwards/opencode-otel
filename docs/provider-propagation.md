# Provider trace-context propagation

Set `propagateTraceContext: true` to add W3C `traceparent` and, when available, `tracestate` to supported provider HTTP requests and experimental WebSocket handshakes. **Off by default.**

| Request | Context selection |
| --- | --- |
| Primary model | Match active session, request kind, and model; use most recently started matching call. |
| Compaction | Match active session and kind. |
| Title or generate | No propagation. |

- Caller-supplied `traceparent` **or** `tracestate` wins; header names are case-insensitive.
- Missing context, unsupported shapes, and injection failures leave provider calls running. Failure diagnostics are rate-limited and content-free.
- Injected headers disclose trace IDs, sampling flags, and any trace state to the provider. They can invalidate signed requests whose signatures include headers.

Verification uses mocked hooks and requests only; no network or provider compatibility test.
