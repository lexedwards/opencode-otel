---
name: Opt-in model content capture
status: accepted
---
# Opt-in model content capture

## Context

Model input and output can contain credentials, private instructions, and binary attachments. Operational telemetry is useful without that content by default, while some operators need bounded examples for diagnosis.

## Decision

Keep content capture disabled by default and allow independent input-message, output-message, system-instruction, and tool-definition opt-ins. Redact credential fields and configured matches before applying UTF-8 and serialized-attribute limits; omit inline binary payloads entirely. Represent supported content as pinned GenAI structured JSON on model spans, never on agent roots. Compaction may expose only its completed summary, not a partial input transcript.

## Consequences

- Explicit opt-in can disclose remaining unrecognized sensitive data; operators control redaction matches and collector access.
- Byte and message limits protect exporters while preserving message order; old input messages may be omitted.
- Unobservable or unsupported content is omitted rather than inferred from incomplete events.
