# Changelog

## [0.1.0] - 2026-09-25

- Private OTLP traces and metrics for agent execution, tool/model operations, compaction, child/fork links, and permission waits and outcomes.
- Explicit HTTP/protobuf and HTTP/JSON with TLS/mTLS; experimental gRPC under Bun.
- Opt-in W3C provider propagation and separately opted-in bounded model, tool, and error content capture.
- Unit-verified OpenCode 2.0.16 integration contracts and pinned OpenTelemetry GenAI v1.40.0 vocabulary.

Verification uses Bun unit tests and package checks; it does not establish launched OpenCode or Collector interoperability. gRPC under Bun remains experimental.

[0.1.0]: https://github.com/lexedwards/opencode-otel/releases/tag/v0.1.0
