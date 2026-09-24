---
name: OTLP exporter packages under Bun
status: accepted
---
# OTLP exporter packages under Bun

## Context

OpenCode runs plugins under Bun, while the OpenTelemetry JavaScript exporters target Node.js. The three OTLP transports need distinct serializers and security interfaces; a dependency declaration alone does not establish runtime compatibility.

## Decision

Use the official `@opentelemetry/exporter-{trace,metrics}-otlp-{proto,http,grpc}` packages at the same pinned release for HTTP/protobuf, HTTP/JSON, and gRPC, respectively. Treat gRPC on Bun as experimental: constructor-level compatibility is verified without network I/O, but neither successful delivery nor interoperability is established.

## Consequences

- Explicit transport selection avoids a silent fallback that could alter security or wire format.
- Both HTTP transports use the Node HTTP agent for TLS/mTLS; gRPC requires channel credentials and metadata instead.
- Bun or upstream exporter updates require rechecking import, construction, and configuration behavior; gRPC requires independent operational validation before claiming production support.
