---
name: Fixed process-wide telemetry configuration
status: accepted
---
# Fixed process-wide telemetry configuration

## Context

OpenCode may load a plugin in several locations in one service process. Exporter pipelines share process resources, and OpenCode does not provide reliable config-file provenance.

## Decision

The first effective configuration establishes the process-wide telemetry configuration for all active instances. Conflicting later configurations retain the established settings and emit a safe diagnostic advising a service restart. Release the configuration after the final instance unloads.

## Consequences

- Configuration changes during an active service require a restart.
- Diagnostics describe the conflict without revealing secrets or claiming which file caused it.
