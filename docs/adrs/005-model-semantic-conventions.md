---
name: Model operation semantic conventions
status: accepted
---
# Model operation semantic conventions

## Context

OpenCode exposes provider IDs and model steps, but not a stable distinction between every upstream model operation type. GenAI semantic conventions evolve independently of OpenCode and do not currently provide a GenAI schema URL suitable for these spans.

## Decision

Pin the GenAI vocabulary to OpenTelemetry semantic-conventions [v1.40.0] commit `7fe537301d17919af7d7eb65b32e9be35da2c497`. Classify primary model steps as `chat` and omit a schema URL. Map known OpenCode provider IDs to canonical GenAI provider names; preserve unknown IDs exactly rather than guessing their identity.

## Consequences

- The `chat` classification may be less specific than the underlying provider operation.
- Unrecognized custom provider IDs can add cardinality to provider dimensions; operators control these IDs.
- Metrics absent from the pinned vocabulary are documented as provisional, rather than claimed as stable conventions.

[v1.40.0]: https://github.com/open-telemetry/semantic-conventions/tree/7fe537301d17919af7d7eb65b32e9be35da2c497
