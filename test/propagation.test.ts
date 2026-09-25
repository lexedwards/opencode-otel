import { expect, test } from "bun:test"
import { createTraceState, SpanKind, trace } from "@opentelemetry/api"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { resolveConfig } from "../src/config"
import { injectTraceHeaders } from "../src/propagation"
import { createTelemetry } from "../src/telemetry"

test("propagation defaults off and rejects invalid configuration without leaking values", () => {
  expect(resolveConfig({ endpoint: "https://collector.test" }, {}).propagateTraceContext).toBe(false)
  const config = resolveConfig({ endpoint: "https://collector.test", propagateTraceContext: "private" }, {})
  expect(config.propagateTraceContext).toBe(false)
  expect(config.diagnostics.join(" ")).not.toContain("private")
})

test("only active primary and compaction model contexts inject W3C HTTP and WS headers", async () => {
  const spans = new InMemorySpanExporter()
  const config = resolveConfig({ endpoint: "https://collector.test", propagateTraceContext: true }, {})
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans })
  const execution = pipeline.execution
  expect(execution.contextForRequest("session-1", "primary", { id: "model", providerID: "openai" })).toBeUndefined()
  execution.onEvent({ type: "session.execution.started", id: "start", created: 1000, data: { sessionID: "session-1" } }, "project")
  execution.onModelEvent({
    type: "session.step.started",
    id: "step",
    created: 1100,
    data: { sessionID: "session-1", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } }
  })
  const selected = execution.contextForRequest("session-1", "primary", { id: "model", providerID: "openai" })!
  expect(selected).toBeDefined()
  expect(execution.contextForRequest("session-1", "primary", { id: "other", providerID: "openai" })).toBeUndefined()
  expect(execution.contextForRequest("session-1", "title", { id: "model", providerID: "openai" })).toBeUndefined()
  const http = new Headers({ authorization: "Bearer private" })
  expect(injectTraceHeaders(http, selected)).toBe(true)
  expect(http.get("traceparent")).toBe(`00-${selected.traceId}-${selected.spanId}-01`)
  expect(http.get("authorization")).toBe("Bearer private")
  const ws: Record<string, string> = {}
  expect(injectTraceHeaders(ws, selected)).toBe(true)
  expect(ws.traceparent).toBe(http.get("traceparent")!)
  execution.onCompactionEvent({ type: "session.compaction.started", id: "compaction", created: 1200, data: { sessionID: "session-1", reason: "auto" } })
  const compact = execution.contextForRequest("session-1", "compaction", { id: "model", providerID: "openai" })!
  expect(compact.spanId).not.toBe(selected.spanId)
  execution.onModelEvent({ type: "session.step.ended", id: "step-end", created: 1300, data: { sessionID: "session-1", assistantMessageID: "msg" } })
  expect(execution.contextForRequest("session-1", "primary", { id: "model", providerID: "openai" })).toBeUndefined()
  execution.onCompactionEvent({
    type: "session.compaction.ended",
    id: "compaction-end",
    created: 1400,
    data: { sessionID: "session-1", reason: "auto", model: { id: "model", providerID: "openai" } }
  })
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans().filter((s) => s.kind === SpanKind.CLIENT)).toHaveLength(2)
  await pipeline.shutdown()
})

test("existing headers win, tracestate is forwarded, and immutable headers fail open", () => {
  const context = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", traceFlags: 1, traceState: createTraceState("vendor=value") }
  const headers = new Headers({ TraceParent: "caller-value", authorization: "private" })
  expect(injectTraceHeaders(headers, context)).toBe(false)
  expect(headers.get("traceparent")).toBe("caller-value")
  expect(headers.get("tracestate")).toBeNull()
  const ws = { TraceState: "caller-state" }
  expect(injectTraceHeaders(ws, context)).toBe(false)
  expect(ws).toEqual({ TraceState: "caller-state" })
  const empty = new Headers()
  expect(injectTraceHeaders(empty, context)).toBe(true)
  expect(empty.get("tracestate")).toBe("vendor=value")
  const unavailable = new Proxy(
    {},
    {
      ownKeys() {
        throw Error("private error")
      }
    }
  ) as Record<string, string>
  expect(() => injectTraceHeaders(unavailable, context)).toThrow()
  const blocked: Record<string, string> = {}
  Object.defineProperty(blocked, "traceparent", {
    set() {
      throw Error("private setter")
    },
    configurable: true
  })
  expect(() => injectTraceHeaders(blocked, context)).toThrow()
  expect(blocked.tracestate).toBeUndefined()
  expect(trace.getTracerProvider()).toBeDefined()
})
