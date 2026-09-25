import { expect, spyOn, test } from "bun:test"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { resolveConfig } from "../src/config"
import { createTelemetry, type ExecutionEvent } from "../src/telemetry"

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
  pipeline.execution.onEvent(
    {
      ...fixture("session.execution.failed", "end-2", 2000),
      data: { sessionID: "session-1", error: { type: "provider.timeout", status: 503, message: "secret /private/path" } }
    },
    "project"
  )
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
    expect(
      metrics
        .getMetrics()
        .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
        .some((m) => m.descriptor.name === "gen_ai.invoke_agent.duration")
    ).toBe(true)
    await pipeline.shutdown()
  } finally {
    if (previous === undefined) delete process.env.OTEL_TRACES_SAMPLER
    else process.env.OTEL_TRACES_SAMPLER = previous
  }
})

test("failed exporters do not interrupt execution telemetry and shutdown is bounded", async () => {
  const never = new Promise<void>(() => {})
  const failing: SpanExporter = {
    export(_spans, callback) {
      callback({ code: 1 })
    },
    shutdown() {
      return never
    }
  }
  const pipeline = createTelemetry(config, "2.0.16", { traces: failing }, 10)
  expect(() => {
    pipeline.execution.onEvent(fixture("session.execution.started", "start-failure", 1000), "project")
    pipeline.execution.onEvent(fixture("session.execution.failed", "end-failure", 2000), "project")
  }).not.toThrow()
  await expect(Promise.race([pipeline.shutdown().then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("timed out"), 100))])).resolves.toBe(
    "closed"
  )
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
  send("session.step.ended", "step-end", 2300, {
    finish: "stop",
    cost: 0.025,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
    providerState: { secret: "do not export" }
  })
  send("session.step.ended", "step-end", 2300, { finish: "stop", cost: 0.025, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } })
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "root-end", 2500), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const [root, model] = spans.getFinishedSpans().sort((a, b) => (a.name === "invoke_agent" ? -1 : 1))
  expect(spans.getFinishedSpans()).toHaveLength(2)
  expect(model?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId)
  expect(model?.kind).toBe(SpanKind.CLIENT)
  expect(model?.name).toBe("chat claude-test")
  expect(model?.attributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-test",
    "gen_ai.usage.input_tokens": 17,
    "gen_ai.usage.output_tokens": 5,
    "opencode.gen_ai.retry.count": 1
  })
  expect(model?.events).toHaveLength(1)
  expect(JSON.stringify({ attributes: model?.attributes, events: model?.events })).not.toMatch(/secret|do not export/)
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const metric = (name: string) => data.find((m) => m.descriptor.name === name)
  expect(
    metric("gen_ai.client.token.usage")
      ?.dataPoints.map((p) => [p.attributes["gen_ai.token.type"], (p.value as { sum: number }).sum])
      .sort()
  ).toEqual([
    ["input", 17],
    ["output", 5]
  ])
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
  pipeline.execution.onModelEvent({
    type: "session.step.started",
    id: "start-step",
    created: 1100,
    data: { sessionID: "session-1", assistantMessageID: "msg-a", model: { id: "model-a", providerID: "google-vertex" } }
  })
  pipeline.execution.onModelEvent({
    type: "session.step.failed",
    id: "fail-step",
    created: 1600,
    data: { sessionID: "session-1", assistantMessageID: "msg-a", error: { type: "provider.timeout", message: "private key" } }
  })
  pipeline.execution.onModelEvent({
    type: "session.step.failed",
    id: "fail-step",
    created: 1600,
    data: { sessionID: "session-1", assistantMessageID: "msg-a", error: { type: "private key", message: "private key" } }
  })
  pipeline.execution.onModelEvent({
    type: "session.step.started",
    id: "start-next",
    created: 1700,
    data: { sessionID: "session-1", assistantMessageID: "msg-b", model: { id: "model-b", providerID: "custom-provider" } }
  })
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
  const pipeline = createTelemetry(resolveConfig({ endpoint: "https://collector.test", providerNames: { "custom-provider": "openai" } }, {}), "2.0.16", {
    traces: spans
  })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-override", 1000), "project")
  pipeline.execution.onModelEvent({
    type: "session.step.started",
    id: "step-override",
    created: 1100,
    data: { sessionID: "session-1", assistantMessageID: "msg-a", model: { id: "a", providerID: "custom-provider" } }
  })
  pipeline.execution.onModelEvent({
    type: "session.step.ended",
    id: "end-override",
    created: 1300,
    data: { sessionID: "session-1", assistantMessageID: "msg-a" }
  })
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-override-root", 1500), "project")
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT)?.attributes["gen_ai.provider.name"]).toBe("openai")
  await pipeline.shutdown()
})

test("permission asks and decisions annotate agent root and measure wait without resources", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-permission", 1000), "project")
  pipeline.execution.onPermissionEvent({
    id: "asked-1",
    created: 1200,
    type: "permission.asked",
    data: { id: "permission-1", sessionID: "session-1", action: "shell", resources: ["secret /private/path"], message: "secret" }
  })
  pipeline.execution.onPermissionEvent({
    id: "asked-1",
    created: 1200,
    type: "permission.asked",
    data: { id: "permission-1", sessionID: "session-1", action: "shell", resources: ["secret /private/path"] }
  })
  pipeline.execution.onPermissionEvent({
    id: "reply-1",
    created: 1700,
    type: "permission.replied",
    data: { requestID: "permission-1", sessionID: "session-1", reply: "reject" }
  })
  pipeline.execution.onPermissionEvent({
    id: "reply-1",
    created: 1700,
    type: "permission.replied",
    data: { requestID: "permission-1", sessionID: "session-1", reply: "reject" }
  })
  pipeline.execution.onEvent(fixture("session.execution.failed", "end-permission", 1900), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const [root] = spans.getFinishedSpans()
  expect(root?.events.map((event) => [event.name, event.attributes])).toEqual([
    ["opencode.permission.asked", { "opencode.permission.action": "shell" }],
    ["opencode.permission.replied", { "opencode.permission.action": "shell", "opencode.permission.reply": "reject" }]
  ])
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const metric = (name: string) => data.find((m) => m.descriptor.name === name)
  expect(metric("opencode.permission.request.count")?.dataPoints[0]?.value).toBe(1)
  expect(metric("opencode.permission.reply.count")?.dataPoints[0]?.value).toBe(1)
  expect(metric("opencode.permission.wait.duration")?.dataPoints[0]?.value).toMatchObject({ sum: 0.5, count: 1 })
  expect(metric("opencode.permission.reply.count")?.dataPoints[0]?.attributes).toMatchObject({
    "opencode.permission.action": "shell",
    "opencode.permission.reply": "reject"
  })
  expect(JSON.stringify({ events: root?.events, data })).not.toMatch(/secret|private|permission-1/)
  await pipeline.shutdown()
})

test("permission telemetry bounds orphaned, expired and out-of-order events", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-orphans", 1000), "project")
  const diagnostic = spyOn(console, "info").mockImplementation(() => {})
  const asked = (id: string, created: number, action = "unknown/private/path") =>
    pipeline.execution.onPermissionEvent({
      id: `ask-${id}`,
      created,
      type: "permission.asked",
      data: { id, sessionID: "session-1", action, resources: ["private path"], save: ["private glob"] }
    })
  const replied = (id: string, created: number, reply: "once" | "always" | "reject" = "always") =>
    pipeline.execution.onPermissionEvent({ id: `reply-${id}`, created, type: "permission.replied", data: { requestID: id, sessionID: "session-1", reply } })
  replied("out-of-order", 1100)
  asked("out-of-order", 1200)
  asked("stale", 1300)
  asked("live", 30 * 60_000 + 1400)
  replied("stale", 30 * 60_000 + 1500)
  replied("live", 30 * 60_000 + 1600)
  replied("live", 30 * 60_000 + 1600)
  expect(diagnostic.mock.calls).toHaveLength(1)
  expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|stale|live|out-of-order/)
  diagnostic.mockRestore()
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-orphans", 30 * 60_000 + 1700), "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  expect(spans.getFinishedSpans()[0]?.events.map((event) => event.name)).toEqual([
    "opencode.permission.asked",
    "opencode.permission.asked",
    "opencode.permission.replied"
  ])
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const metric = (name: string) => data.find((m) => m.descriptor.name === name)
  expect(metric("opencode.permission.request.count")?.dataPoints[0]?.value).toBe(2)
  expect(metric("opencode.permission.reply.count")?.dataPoints[0]?.value).toBe(1)
  expect(metric("opencode.permission.wait.duration")?.dataPoints[0]?.value).toMatchObject({ sum: 0.2, count: 1 })
  expect(metric("opencode.permission.request.count")?.dataPoints[0]?.attributes).toEqual({ "opencode.permission.action": "other" })
  expect(JSON.stringify({ events: spans.getFinishedSpans()[0]?.events, data })).not.toMatch(/private|stale|live|out-of-order/)
  await pipeline.shutdown()
})

test("permission reply metric distinguishes once, always, and reject", async () => {
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "start-decisions", 1000), "project")
  for (const [index, reply] of (["once", "always", "reject"] as const).entries()) {
    const requestID = `permission-${index}`
    pipeline.execution.onPermissionEvent({
      type: "permission.asked",
      id: `ask-${index}`,
      created: 1200,
      data: { sessionID: "session-1", id: requestID, action: "read" }
    })
    pipeline.execution.onPermissionEvent({
      type: "permission.replied",
      id: `reply-${index}`,
      created: 1300,
      data: { sessionID: "session-1", requestID, reply }
    })
  }
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "end-decisions", 1500), "project")
  await pipeline.metrics?.forceFlush()
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const replies = data.find((m) => m.descriptor.name === "opencode.permission.reply.count")
  expect(replies?.dataPoints.map((point) => [point.attributes["opencode.permission.reply"], point.value]).sort()).toEqual([
    ["always", 1],
    ["once", 1],
    ["reject", 1]
  ])
  await pipeline.shutdown()
})

test("compaction is a private client sibling during execution and a standalone trace when manual", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent(fixture("session.execution.started", "root-compact", 1000), "project")
  const send = (type: "session.compaction.started" | "session.compaction.ended", sessionID: string, id: string, created: number) =>
    pipeline.execution.onCompactionEvent({
      type,
      id,
      created,
      data: {
        sessionID,
        reason: sessionID === "session-1" ? "auto" : "manual",
        recent: "secret transcript",
        text: "secret summary",
        model: { id: "claude-test", providerID: "anthropic" },
        tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 1 } },
        cost: 0.01
      }
    })
  send("session.compaction.started", "session-1", "compact-start", 1100)
  send("session.compaction.started", "session-1", "compact-start", 1100)
  pipeline.execution.onCompactionEvent({
    type: "session.compaction.delta",
    id: "compact-delta",
    created: 1200,
    data: { sessionID: "session-1", reason: "auto", text: "secret partial summary" }
  } as any)
  send("session.compaction.ended", "session-1", "compact-end", 1600)
  send("session.compaction.ended", "session-1", "compact-end", 1600)
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "root-compact-end", 2000), "project")
  send("session.compaction.started", "manual-session", "manual-start", 2100)
  send("session.compaction.ended", "manual-session", "manual-end", 2500)
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  const finished = spans.getFinishedSpans()
  expect(finished).toHaveLength(3)
  const root = finished.find((span) => span.name === "invoke_agent")!
  const compact = finished.filter((span) => span.kind === SpanKind.CLIENT)
  expect(compact).toHaveLength(2)
  expect(compact[0]?.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
  expect(compact[1]?.parentSpanContext).toBeUndefined()
  expect(compact[1]?.spanContext().traceId).not.toBe(root.spanContext().traceId)
  expect(compact[0]?.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "opencode.model.kind": "compaction" })
  expect(JSON.stringify(compact.map((span) => ({ attributes: span.attributes, events: span.events })))).not.toMatch(/secret|transcript|summary/)
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  expect(data.find((m) => m.descriptor.name === "gen_ai.client.operation.duration")?.dataPoints[0]?.value).toMatchObject({ count: 2 })
  expect(data.find((m) => m.descriptor.name === "gen_ai.invoke_agent.inference_calls")?.dataPoints[0]?.value).toMatchObject({ sum: 1 })
  await pipeline.shutdown()
})

test("child and fork executions start separate traces linked to an active parent", async () => {
  const spans = new InMemorySpanExporter()
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans })
  pipeline.execution.onEvent(fixture("session.execution.started", "parent-start", 1000), "project")
  for (const [index, type] of (["session.created", "session.forked"] as const).entries()) {
    const sessionID = `child-${index}`
    pipeline.execution.onSessionRelation({ id: `relation-${index}`, created: 1100, type, data: { sessionID, parentID: "session-1", title: "private path" } })
    pipeline.execution.onEvent({ type: "session.execution.started", id: `child-start-${index}`, created: 1200, data: { sessionID } }, "project")
    pipeline.execution.onEvent({ type: "session.execution.succeeded", id: `child-end-${index}`, created: 1300, data: { sessionID } }, "project")
  }
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "parent-end", 1400), "project")
  await pipeline.traces?.forceFlush()
  const [parent, ...children] = spans.getFinishedSpans().sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])
  expect(children).toHaveLength(2)
  for (const child of children) {
    expect(child.parentSpanContext).toBeUndefined()
    expect(child.spanContext().traceId).not.toBe(parent?.spanContext().traceId)
    expect(child.links).toHaveLength(1)
    expect(child.links[0]?.context).toMatchObject({ traceId: parent?.spanContext().traceId, spanId: parent?.spanContext().spanId })
    expect(JSON.stringify(child.attributes)).not.toContain("private path")
  }
  await pipeline.shutdown()
})

test("configured expiry abandons stale executions and standalone compactions once", async () => {
  const spans = new InMemorySpanExporter()
  let now = 1000
  const config = resolveConfig({ endpoint: "https://collector.test", executionExpiryMillis: 5000 }, {})
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans }, 5000, () => now)
  pipeline.execution.onEvent(fixture("session.execution.started", "stale-start", 1000), "project")
  pipeline.execution.onModelEvent({
    type: "session.step.started",
    id: "stale-model",
    created: 1100,
    data: { sessionID: "session-1", assistantMessageID: "msg-stale", model: { id: "test", providerID: "openai" } }
  })
  pipeline.execution.onCompactionEvent({
    type: "session.compaction.started",
    id: "standalone-start",
    created: 1200,
    data: { sessionID: "manual", reason: "manual", recent: "secret" }
  })
  now = 5900
  pipeline.execution.expire()
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans()).toHaveLength(0)
  now = 6200
  const diagnostic = spyOn(console, "info").mockImplementation(() => {})
  pipeline.execution.expire()
  pipeline.execution.expire()
  expect(diagnostic.mock.calls).toHaveLength(1)
  diagnostic.mockRestore()
  await pipeline.traces?.forceFlush()
  const finished = spans.getFinishedSpans()
  expect(finished).toHaveLength(3)
  expect(finished.find((span) => span.name === "invoke_agent")?.attributes["opencode.execution.outcome"]).toBe("abandoned")
  expect(finished.filter((span) => span.kind === SpanKind.CLIENT).every((span) => span.attributes["opencode.model.outcome"] === "abandoned")).toBe(true)
  pipeline.execution.onEvent(fixture("session.execution.succeeded", "late-end", 7000), "project")
  await pipeline.traces?.forceFlush()
  expect(spans.getFinishedSpans()).toHaveLength(3)
  await pipeline.shutdown()
})

test("terminal events arriving before starts are correlated once when timestamps agree", async () => {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  pipeline.execution.onEvent({ type: "session.execution.succeeded", id: "reordered-root-end", created: 3000, data: { sessionID: "later" } }, "project")
  pipeline.execution.onEvent({ type: "session.execution.started", id: "reordered-root-start", created: 1000, data: { sessionID: "later" } }, "project")
  pipeline.execution.onEvent({ type: "session.execution.started", id: "model-root-start", created: 4000, data: { sessionID: "primary" } }, "project")
  pipeline.execution.onModelEvent({
    type: "session.step.ended",
    id: "reordered-step-end",
    created: 5200,
    data: { sessionID: "primary", assistantMessageID: "msg-reordered", tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
  })
  pipeline.execution.onModelEvent({
    type: "session.step.started",
    id: "reordered-step-start",
    created: 4200,
    data: { sessionID: "primary", assistantMessageID: "msg-reordered", model: { id: "model", providerID: "openai" } }
  })
  pipeline.execution.onCompactionEvent({
    type: "session.compaction.ended",
    id: "reordered-compact-end",
    created: 5700,
    data: { sessionID: "primary", reason: "auto", model: { id: "model", providerID: "openai" } }
  })
  pipeline.execution.onCompactionEvent({
    type: "session.compaction.started",
    id: "reordered-compact-start",
    created: 5400,
    data: { sessionID: "primary", reason: "auto", recent: "secret" }
  })
  pipeline.execution.onEvent({ type: "session.execution.succeeded", id: "model-root-end", created: 6000, data: { sessionID: "primary" } }, "project")
  await pipeline.traces?.forceFlush()
  await pipeline.metrics?.forceFlush()
  expect(spans.getFinishedSpans()).toHaveLength(4)
  expect(spans.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT)).toHaveLength(2)
  const data = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  expect(data.find((m) => m.descriptor.name === "gen_ai.client.operation.duration")?.dataPoints[0]?.value).toMatchObject({ count: 2 })
  await pipeline.shutdown()
})
