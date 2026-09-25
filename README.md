# opencode-otel

Unofficial community OpenCode plugin for OpenTelemetry traces and metrics. Covers agent, tool, model, compaction, and permission operations. Content capture and provider trace propagation are opt-in. Licensed under Apache-2.0.

## Install from Git

Add to `~/.config/opencode/opencode.jsonc` (OpenCode v2):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:lexedwards/opencode-otel#main",
      "options": { "endpoint": "https://collector.example:4318" }
    }
  ]
}
```

| Git ref | Use |
| --- | --- |
| Immutable SemVer tag, e.g. `#v0.1.0` | Recommended **after** that tag is published; pin a verified release. |
| `#main` | Track development until a stable tag exists. |
| No ref | Follow the repository's changing default branch. |

Do not use a mutable `latest` Git ref. Minimum OpenCode version: **2.0.11**; specifically targeted: **2.0.16**. Later v2 compatibility is best-effort; upstream does not promise SemVer compatibility for plugin APIs. See [release readiness](docs/release-checklist.md).

## Configure

| Option | Effect |
| --- | --- |
| `endpoint` | Enable traces and metrics; generic HTTP URL adds `/v1/traces` and `/v1/metrics`. |
| `traces.endpoint` / `metrics.endpoint` | Enable only the specified signal; HTTP URL must include its path. |
| `protocol` | `http/protobuf` (default), `http/json`, or experimental `grpc` under Bun. Set globally or per signal. |
| `capture` | Explicit model, tool, and error-detail opt-ins; metadata-only by default. |
| `propagateTraceContext: true` | Inject W3C context into supported provider requests; off by default. |

No endpoint means no exporter. Per-field precedence: signal option → generic option → signal OTLP environment → generic OTLP environment → default. Restart OpenCode to change the first active process-wide configuration. Exporter failures disable the affected signal without fallback.

For partial signals, TLS/mTLS, `{env:NAME}` secret references, headers, batching, timeouts, sampling, compression, expiry, and resource defaults, use the [operator reference](docs/operator-reference.md). For receiver snippets, use [HTTP](docs/http-collector.md) or [experimental gRPC](docs/grpc-collector.md) guidance.

## Telemetry and privacy

- [Trace topology](docs/architecture.md) · [telemetry inventory](docs/telemetry-inventory.md) · [model metrics](docs/model-telemetry.md) · [permission metrics](docs/permission-telemetry.md)
- [Content capture and redaction](docs/content-capture.md) · [W3C propagation risks](docs/provider-propagation.md)
- [Exporter compatibility](docs/otlp-compatibility.md) · [release checks and limits](docs/release-checklist.md)

Verify locally with `bun install --frozen-lockfile` and `bun run verify`. Tests use mocked or in-memory exporters; they do not launch OpenCode or a Collector.
