---
name: Private process-shared agent telemetry
status: accepted
---
# Private process-shared agent telemetry

## Context

OpenCode can load plugins for multiple locations in a service process. Global OpenTelemetry providers could interfere with other instrumentation, and long-running agent sessions need a trace boundary that represents an execution rather than the whole session.

## Decision

Use process-shared private tracer and meter providers, reference-counted across plugin locations. Start one root trace for each observed agent execution; model and tool operations will join that execution's trace. Keep metrics independent of the tracing sampler.

## Consequences

- Existing global telemetry registrations remain untouched.
- Duplicate event subscriptions must share lifecycle coordination to avoid duplicated spans and measurements.
- The final unload bounds exporter shutdown to avoid blocking OpenCode indefinitely.
