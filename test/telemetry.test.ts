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

test("model steps are one client span per logical call with retries, usage and private metrics", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  const send = (type: string, id: string, created: number, data: Record<string, unknown>) =>
    pipeline.execution.onModelEvent({ type, id, created, data: { sessionID: "session-1", assistantMessageID: "msg-1", ...data } } as any)
  pipeline.execution.onEvent(fixture("session.execution.started", "root-model", 1000), "project")
  send("session.step.started", "step-start", 1200, { started: 1100, model: { id: "claude-test", providerID: "anthropic" }, agent: "build" })
  send("session.retry.scheduled", "retry-1", 1300, { attempt: 2, at: 1400, error: { type: "provider.rate-limit", message: "secret" } })
  send("session.retry.scheduled", "retry-1", 1300, { attempt: 2, at: 1400, error: { type: "provider.rate-limit", message: "secret" } })
  send("session.step.streamed", "stream-1", 1700, {})
  send("session.step.ended", "step-end", 2300, { finish: "stop", cost: 0.025, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }, providerState: { secret: "do not export" } })
  send("session.step.ended", "step-end", 2300, { finish: "stop", cost: 0.025, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } })
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "root-end", 2500), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const [root, model] = spans.getFinishedSpans().sort((a, b) => a.name === "invoke_agent" ? -1 : 1)
  expect(spans.getFinishedSpans()).toHaveLength(2)
  expect(model?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId)
  expect(model?.kind).toBe(SpanKind.CLIENT)
  expect(model?.name).toBe("chat claude-test")
  expect(model?.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-test", "gen_ai.usage.input_tokens": 17, "gen_ai.usage.output_tokens": 5, "opencode.gen_ai.retry.count": 1 })
  expect(model?.events).toHaveLength(1)
  expect(JSON.stringify({ attributes: model?.attributes, events: model?.events })).not.toMatch(/secret|do not export/)
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const metric = (name: string) => data.find((m) => m.descriptor.name === name)
  expect(metric("gen_ai.client.token.usage")?.dataPoints.map((p) => [p.attributes["gen_ai.token.type"], (p.value as { sum: number }).sum]).sort()).toEqual([["input", 17], ["output", 5]])
  expect(metric("gen_ai.client.operation.duration")?.dataPoints[0]?.value).toMatchObject({ sum: 1.2, count: 1 })
  expect(metric("gen_ai.client.operation.time_to_first_chunk")?.dataPoints[0]?.value).toMatchObject({ sum: 0.6, count: 1 })
  expect(metric("gen_ai.invoke_agent.inference_calls")?.dataPoints[0]?.value).toMatchObject({ sum: 1, count: 1 })
  expect(metric("opencode.gen_ai.cost")?.dataPoints[0]?.value).toBe(0.025)
  expect(metric("opencode.gen_ai.retry.count")?.dataPoints[0]?.value).toBe(1)
  expect(metric("gen_ai.client.operation.time_per_output_chunk")).toBeUndefined()
  expect(JSON.stringify(data)).not.toMatch(/secret|claude-test|project/)
  await pipeline.shutdown()
})

test("failed and interrupted model operations end once without leaking errors or estimating usage", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "start", 1000), "project")
  pipeline.execution.onModelEvent({ type: "session.step.started", id: "start-step", created: 1100, data: { sessionID: "session-1", assistantMessageID: "msg-a", model: { id: "model-a", providerID: "google-vertex" } } })
  pipeline.execution.onModelEvent({ type: "session.step.failed", id: "fail-step", created: 1600, data: { sessionID: "session-1", assistantMessageID: "msg-a", error: { type: "provider.timeout", message: "private key" } } })
  pipeline.execution.onModelEvent({ type: "session.step.failed", id: "fail-step", created: 1600, data: { sessionID: "session-1", assistantMessageID: "msg-a", error: { type: "private key", message: "private key" } } })
  pipeline.execution.onModelEvent({ type: "session.step.started", id: "start-next", created: 1700, data: { sessionID: "session-1", assistantMessageID: "msg-b", model: { id: "model-b", providerID: "custom-provider" } } })
  pipeline.execution.onEvent(fixture("session.execution.interrupted", "stop", 2000), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const model = spans.getFinishedSpans().filter((s) => s.kind === SpanKind.CLIENT)
  expect(model).toHaveLength(2)
  expect(model[0]?.attributes["gen_ai.provider.name"]).toBe("gcp.vertex_ai")
  expect(model[0]?.attributes["error.type"]).toBe("provider.timeout")
  expect(model[0]?.status.code).toBe(SpanStatusCode.ERROR)
  expect(model[1]?.attributes["gen_ai.provider.name"]).toBe("custom-provider")
  expect(model[1]?.attributes["opencode.model.outcome"]).toBe("abandoned")
  expect(JSON.stringify(model.map((s) => ({ attributes: s.attributes, events: s.events })))).not.toContain("private key")
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  expect(data.find((m) => m.descriptor.name === "gen_ai.client.token.usage")).toBeUndefined()
  expect(data.find((m) => m.descriptor.name === "gen_ai.invoke_agent.inference_calls")?.dataPoints[0]?.value).toMatchObject({ sum: 1 })
  await pipeline.shutdown()
})

test("provider override applies without changing unknown provider IDs", async () => {
  const spans = new InMemorySpanExporter()
  const pipeline = createTelemetry(resolveConfig({ endpoint: "https://collector.test", providerNames: { "custom-provider": "openai" } }, {}), "2.0.16", { traces: spans })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-override", 1000), "project")
  pipeline.execution.onModelEvent({ type: "session.step.started", id: "step-override", created: 1100, data: { sessionID: "session-1", assistantMessageID: "msg-a", model: { id: "a", providerID: "custom-provider" } } })
  pipeline.execution.onModelEvent({ type: "session.step.ended", id: "end-override", created: 1300, data: { sessionID: "session-1", assistantMessageID: "msg-a" } })
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-override-root", 1500), "project")
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT)?.attributes["gen_ai.provider.name"]).toBe("openai")
  await pipeline.shutdown()
})
