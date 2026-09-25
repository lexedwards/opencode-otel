import { expect, test } from "bun:test"
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { resolveConfig } from "../src/config"
import { createTelemetry } from "../src/telemetry"

test("default release fixture excludes paths, credentials and content from telemetry and diagnostics", async () => {
  const config = resolveConfig(
    { endpoint: "https://collector.test", traces: { headers: { Authorization: "{env:AUTH}" } } },
    { AUTH: "Bearer secret-credential" }
  )
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const telemetry = createTelemetry(config, "2.0.16", { traces: spans, metrics })
  const c = telemetry.execution
  c.onEvent(
    { type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" }, location: { workspaceID: "/private/workspace" } },
    "/private/project"
  )
  c.onPermissionEvent({
    type: "permission.asked",
    id: "ask",
    created: 1100,
    data: { id: "p", sessionID: "session", action: "shell", resources: ["/private/path"], message: "Bearer secret-credential" }
  })
  c.onPermissionEvent({ type: "permission.replied", id: "reply", created: 1200, data: { requestID: "p", sessionID: "session", reply: "reject" } })
  c.toolBefore({ sessionID: "session", id: "tool", tool: "shell", input: { command: "cat /private/path", authorization: "Bearer secret-credential" } })
  c.toolAfter({
    sessionID: "session",
    id: "tool",
    tool: "shell",
    status: "error",
    error: { message: "secret stack /private/path", stack: "Bearer secret-credential" }
  })
  c.onModelEvent({
    type: "session.step.started",
    id: "step",
    created: 1300,
    data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } }
  })
  c.onTextEnded({ type: "session.text.ended", data: { sessionID: "session", assistantMessageID: "msg", ordinal: 0, text: "private prompt response" } })
  c.onModelEvent({
    type: "session.step.failed",
    id: "model-end",
    created: 1400,
    data: { sessionID: "session", assistantMessageID: "msg", error: { type: "unknown", message: "Bearer secret-credential", stack: "/private/path" } }
  })
  c.onEvent(
    {
      type: "session.execution.failed",
      id: "root-end",
      created: 1500,
      data: { sessionID: "session", error: { type: "unknown", message: "/private/path", status: 403 } }
    },
    "/private/project"
  )
  await telemetry.traces?.forceFlush()
  await telemetry.metrics?.forceFlush()
  const records = metrics.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
  const payload = JSON.stringify({
    diagnostics: config.diagnostics,
    spans: spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })),
    metrics: records
  })
  expect(payload).not.toMatch(/\/private\/|secret-credential|private prompt response|cat \/private|exception\.message|exception\.stacktrace|authorization/i)
  expect(spans.getFinishedSpans().find((span) => span.name === "invoke_agent")?.attributes).toMatchObject({
    "opencode.project.id": "unknown",
    "opencode.workspace.id": "unknown"
  })
  expect(
    records.every((record) =>
      record.dataPoints.every((point) => !Object.keys(point.attributes).some((key) => key.includes("project") || key.includes("workspace")))
    )
  ).toBe(true)
  expect(records.some((record) => record.descriptor.name === "opencode.permission.wait.duration")).toBe(true)
  await telemetry.shutdown()
})
