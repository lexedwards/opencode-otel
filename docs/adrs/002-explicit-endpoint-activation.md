---
name: Explicit OTLP endpoint activation
status: accepted
---
# Explicit OTLP endpoint activation

## Context

OpenTelemetry exporters otherwise default to localhost even when the operator never configured telemetry. Installation alone must not cause any attempt to send data.

## Decision

Enable a signal only with an explicit signal-specific or generic endpoint. Do not instantiate an exporter for a disabled signal; generic endpoints activate both signals, while a signal-specific endpoint activates only that signal.

## Consequences

- No collector is contacted by an unconfigured installation.
- Operators must opt in separately when they want only one signal.
