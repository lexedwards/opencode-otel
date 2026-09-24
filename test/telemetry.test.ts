import { expect, test } from "bun:test"
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { createTelemetry, type ExecutionEvent } from "../src/telemetry"
import { resolveConfig } from "../src/config"

const config = resolveConfig({ endpoint: "https://collector.test" }, {})
function fixture(type: ExecutionEvent["type"], id: string, created: number): ExecutionEvent {
  return { type, id, created, data: { sessionID: "session-1" }, location: { directory: "/private/path", workspaceID: "opaque-workspace" } }
}

test("agent root and duration are private, deduplicated and independent of global providers", async () => {
  const before = trace.getTracerProvider()
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-1", 1000), "opaque-project")
  pipeline.execution.onEvent(fixture("session.execution.started", "start-1", 1000), "opaque-project")
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-1", 3500), "opaque-project")
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-1", 3500), "opaque-project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  expect(trace.getTracerProvider()).toBe(before)
  const [span] = spans.getFinishedSpans()
  expect(spans.getFinishedSpans()).toHaveLength(1)
  expect(span.name).toBe("invoke_agent")
  expect(span.kind).toBe(SpanKind.INTERNAL)
  expect(span.status.code).toBe(SpanStatusCode.OK)
  expect(span.attributes["opencode.project.id"]).toBe("opaque-project")
  expect(span.attributes["opencode.workspace.id"]).toBe("opaque-workspace")
  expect(span.resource.attributes["service.name"]).toBe("opencode")
  expect(span.resource.attributes["service.version"]).toBe("2.0.16")
  expect(span.resource.attributes["service.instance.id"]).toBeString()
  expect(JSON.stringify(span.attributes)).not.toContain("/private/path")
  const data = metrics.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
  const duration = data.find((metric) => metric.descriptor.name === "gen_ai.invoke_agent.duration")
  expect(duration?.dataPoints).toHaveLength(1)
  expect(duration?.dataPoints[0]?.attributes).not.toHaveProperty("opencode.project.id")
  expect(duration?.dataPoints[0]?.attributes).not.toHaveProperty("opencode.workspace.id")
  await pipeline.shutdown()
})

test("failed execution exports only bounded error type and status, never message", async () => {
  const spans = new InMemorySpanExporter()
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-2", 1000), "project")
  pipeline.execution.onEvent({ ...fixture("session.execution.failed", "end-2", 2000), data: { sessionID: "session-1", error: { type: "provider.timeout", status: 503, message: "secret /private/path" } } }, "project")
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR)
  expect(spans.getFinishedSpans()[0]?.attributes["error.type"]).toBe("provider.timeout")
  expect(spans.getFinishedSpans()[0]?.attributes["opencode.error.status"]).toBe(503)
  expect(JSON.stringify(spans.getFinishedSpans()[0]?.attributes)).not.toContain("secret")
  await pipeline.shutdown()
})

test("metrics survive always-off trace sampling", async () => {
  const previous = process.env.OTEL_TRACES_SAMPLER
  process.env.OTEL_TRACES_SAMPLER = "always_off"
  try {
    const spans = new InMemorySpanExporter()
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
    pipeline.execution.onEvent(fixture("session.execution.started", "start-3", 1000), "project")
    pipeline.execution.onEvent(fixture("session.execution.interrupted", "end-3", 2000), "project")
    await pipeline.traces?.forceFlush()
    await pipeline.metrics?.forceFlush()
    expect(spans.getFinishedSpans()).toHaveLength(0)
    expect(metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics)).some((m) => m.descriptor.name === "gen_ai.invoke_agent.duration")).toBe(true)
    await pipeline.shutdown()
  } finally {
    if (previous === undefined) delete process.env.OTEL_TRACES_SAMPLER
    else process.env.OTEL_TRACES_SAMPLER = previous
  }
})

test("failed exporters do not interrupt execution telemetry and shutdown is bounded", async () => {
  const never = new Promise<void>(() => {})
  const failing: SpanExporter = {
    export(_spans, callback) { callback({ code: 1 }) },
    shutdown() { return never },
  }
  const pipeline = createTelemetry(config, "2.0.16", { traces: failing }, 10)
  expect(() => {
    pipeline.execution.onEvent(fixture("session.execution.started", "start-failure", 1000), "project")
    pipeline.execution.onEvent(fixture("session.execution.failed", "end-failure", 2000), "project")
  }).not.toThrow()
  await expect(Promise.race([pipeline.shutdown().then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("timed out"), 100))])).resolves.toBe("closed")
})

test("overlapping tools are root children with private, once-only outcomes and counts", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  let time = 1500
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics }, 5000, () => time)
  pipeline.execution.onEvent(fixture("session.execution.started", "root-tool", 1000), "project")
  pipeline.execution.toolBefore({ sessionID: "session-1", id: "call-a", tool: "shell", input: "secret /private/path" })
  pipeline.execution.toolBefore({ sessionID: "session-1", id: "call-a", tool: "shell" })
  time = 1600
  pipeline.execution.toolBefore({ sessionID: "session-1", id: "call-b", tool: "read" })
  time = 1800
  pipeline.execution.toolAfter({ sessionID: "session-1", id: "call-a", tool: "shell", status: "error", error: { message: "secret /private/path" } })
  pipeline.execution.toolAfter({ sessionID: "session-1", id: "call-a", tool: "shell", status: "error" })
  time = 2000
  pipeline.execution.toolAfter({ sessionID: "session-1", id: "call-b", tool: "read", status: "completed", result: "secret /private/path" })
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-tool", 2500), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const completed = spans.getFinishedSpans()
  expect(completed).toHaveLength(3)
  const root = completed.find((span) => span.name === "invoke_agent")!
  const tools = completed.filter((span) => span.name === "execute_tool")
  expect(tools).toHaveLength(2)
  for (const tool of tools) {
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    expect(tool.kind).toBe(SpanKind.INTERNAL)
    expect(JSON.stringify(tool.attributes)).not.toMatch(/secret|private|shell|read/)
  }
  expect(tools.map((tool) => tool.status.code).sort()).toEqual([SpanStatusCode.OK, SpanStatusCode.ERROR].sort())
  expect(tools.find((tool) => tool.status.code === SpanStatusCode.ERROR)?.attributes["error.type"]).toBe("tool.error")
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const calls = data.find((metric) => metric.descriptor.name === "gen_ai.invoke_agent.tool_calls")
  expect(calls?.dataPoints[0]?.value).toMatchObject({ sum: 2, count: 1 })
  expect(data.some((metric) => metric.descriptor.name === "gen_ai.execute_tool.duration")).toBe(true)
  expect(JSON.stringify(data)).not.toMatch(/secret|private|shell|read/)
  await pipeline.shutdown()
})
