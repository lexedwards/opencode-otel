# OTLP exporter compatibility

**Evidence:** Bun 1.4.0, OpenTelemetry exporters 0.222.0, `bun test` on 2026-09-24. All six trace/metric constructors imported and shut down successfully. HTTP and gRPC paths are wired; **no network delivery, TLS handshake, Collector, SDK service, live provider, or OpenCode startup was tested**.

| Transport | Trace/metric package suffix | Endpoint | Security/headers |
| --- | --- | --- | --- |
| HTTP/protobuf | `otlp-proto` | Full signal URL, or generic URL with appended signal path | HTTP headers; Node agent `ca`, `cert`, `key` options. |
| HTTP/JSON | `otlp-http` | Same HTTP rules | Same HTTP rules. |
| gRPC (experimental on Bun) | `otlp-grpc` | Host:port or `http(s)://host:port`, no path | gRPC Metadata and channel credentials (`createSsl` / `createInsecure`). |

All use explicit normalized endpoints, `timeoutMillis`, and `none`/`gzip` compression. A signal without an endpoint is never constructed: the exporter SDK's implicit localhost default is **not** a plugin default. Signal endpoints are used as-is; generic HTTP endpoints add `/v1/traces` or `/v1/metrics`. Invalid gRPC paths and incomplete certificate/key pairs are rejected.

Per-field precedence: signal plugin option → generic plugin option → signal OTLP environment → generic OTLP environment → default. Standard OTLP header variables merge case-insensitively; specific keys win. Plugin secret references use `{env:NAME}` for PEM contents or header values; standard certificate variables use PEM file paths. Resolved secrets are separate from printable configuration.

HTTP exporters use Node `http`/`https` agent options; `@grpc/grpc-js` targets Node.js. Bun transport interoperability remains unverified. See [operator settings](operator-reference.md), [HTTP receiver](http-collector.md), and [experimental gRPC receiver](grpc-collector.md).
