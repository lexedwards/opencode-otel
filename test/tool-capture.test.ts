import { expect, test } from "bun:test"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { resolveConfig } from "../src/config"
import { PrivacyPipeline } from "../src/privacy"
import { createTelemetry } from "../src/telemetry"

const source = { nested: { password: "private-password", apiKey: "private-key", harmless: "bearer-123" }, items: [{ type: "base64", data: "INLINE_BINARY" }] }
const error = { type: "PermissionDenied", message: "private message bearer-123", stack: "private stack bearer-123" }

test("tool and error categories are independent of the GenAI message umbrella", () => {
  const all = resolveConfig({}, { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }).capture
  expect([all.toolArguments, all.toolResults, all.errorMessages, all.stackTraces]).toEqual([false, false, false, false])
  const configured = resolveConfig({ capture: { toolArguments: true, stackTraces: true, redactPatterns: ["bearer-[0-9]+"] } }, {}).capture
  expect([configured.toolArguments, configured.toolResults, configured.errorMessages, configured.stackTraces]).toEqual([true, false, false, true])
})

test("default tool and failed model spans retain status without payload or exception details", async () => {
  const spans = new InMemorySpanExporter()
  const telemetry = createTelemetry(resolveConfig({ endpoint: "https://collector.test" }, {}), "2.0.16", { traces: spans })
  const c = telemetry.execution
  c.onEvent({ type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" } }, "project")
  c.toolBefore({ sessionID: "session", id: "tool", tool: "shell", input: source })
  c.toolAfter({ sessionID: "session", id: "tool", tool: "shell", status: "error", error })
  c.onModelEvent({ type: "session.step.started", id: "step", created: 1100, data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } })
  c.onModelEvent({ type: "session.step.failed", id: "step-end", created: 1200, data: { sessionID: "session", assistantMessageID: "msg", error } })
  c.onEvent({ type: "session.execution.failed", id: "end", created: 1300, data: { sessionID: "session", error } }, "project")
  await telemetry.traces?.forceFlush()
  const all = spans.getFinishedSpans()
  expect(all.find((span) => span.name === "chat model")?.attributes["error.type"]).toBe("unknown")
  expect(all.find((span) => span.name === "execute_tool")?.attributes["error.type"]).toBe("tool.error")
  expect(JSON.stringify(all.map((span) => span.attributes))).not.toMatch(/private|gen_ai.tool.call.arguments|gen_ai.tool.call.result|exception.message|exception.stacktrace/)
  await telemetry.shutdown()
})

test("tool payload and exception opt-ins stay on the relevant spans and redact before bounding", async () => {
  const spans = new InMemorySpanExporter()
  const config = resolveConfig({ endpoint: "https://collector.test", capture: { toolArguments: true, toolResults: true, errorMessages: true, stackTraces: false, redactPatterns: ["bearer-[0-9]+"] } }, {})
  const telemetry = createTelemetry(config, "2.0.16", { traces: spans })
  const c = telemetry.execution
  c.onEvent({ type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" } }, "project")
  c.toolBefore({ sessionID: "session", id: "tool-ok", tool: "read", input: source })
  c.toolAfter({ sessionID: "session", id: "tool-ok", tool: "read", status: "completed", result: { value: source } })
  c.toolBefore({ sessionID: "session", id: "tool-bad", tool: "shell", input: source })
  c.toolAfter({ sessionID: "session", id: "tool-bad", tool: "shell", status: "error", error })
  c.onModelEvent({ type: "session.step.started", id: "step", created: 1100, data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } })
  c.onModelEvent({ type: "session.step.failed", id: "step-end", created: 1200, data: { sessionID: "session", assistantMessageID: "msg", error } })
  c.onEvent({ type: "session.execution.failed", id: "end", created: 1300, data: { sessionID: "session", error } }, "project")
  await telemetry.traces?.forceFlush()
  const all = spans.getFinishedSpans()
  const tool = all.find((span) => span.attributes["gen_ai.tool.call.result"])!
  const model = all.find((span) => span.name === "chat model")!
  const root = all.find((span) => span.name === "invoke_agent")!
  const argument = tool.attributes["gen_ai.tool.call.arguments"] as string
  const result = tool.attributes["gen_ai.tool.call.result"] as string
  expect(JSON.parse(argument)).toMatchObject({ nested: { password: "[redacted]", apiKey: "[redacted]", harmless: "[redacted]" } })
  expect(JSON.parse(result)).toMatchObject({ value: { nested: { password: "[redacted]" } } })
  expect(JSON.stringify(all.map((span) => span.attributes))).not.toMatch(/private-password|private-key|bearer-123|INLINE_BINARY|private stack/)
  expect(root.attributes["gen_ai.tool.call.arguments"]).toBeUndefined()
  expect(model.attributes["gen_ai.tool.call.result"]).toBeUndefined()
  expect(model.attributes["exception.message"]).toBe("private message [redacted]")
  expect(model.attributes["exception.stacktrace"]).toBeUndefined()
  expect(root.attributes["exception.message"]).toBe("private message [redacted]")
  expect(all.find((span) => span.attributes["opencode.tool.outcome"] === "error")?.attributes["exception.message"]).toBe("private message [redacted]")
  await telemetry.shutdown()
})

test("stack-only capture and oversized or cyclic tool values remain bounded and fail open", async () => {
  const spans = new InMemorySpanExporter()
  const config = resolveConfig({ endpoint: "https://collector.test", capture: { toolArguments: true, stackTraces: true, redactPatterns: ["bearer-[0-9]+"] } }, {})
  const telemetry = createTelemetry(config, "2.0.16", { traces: spans })
  const c = telemetry.execution
  c.onEvent({ type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" } }, "project")
  const cyclic: Record<string, unknown> = { entries: Array.from({ length: 40 }, (_, i) => `${i}:` + "🦊".repeat(2000)) }
  cyclic.self = cyclic
  c.toolBefore({ sessionID: "session", id: "tool", tool: "shell", input: cyclic })
  c.toolAfter({ sessionID: "session", id: "tool", tool: "shell", status: "error", error })
  c.onEvent({ type: "session.execution.succeeded", id: "end", created: 1300, data: { sessionID: "session" } }, "project")
  await telemetry.traces?.forceFlush()
  const tool = spans.getFinishedSpans().find((span) => span.name === "execute_tool")!
  const json = tool.attributes["gen_ai.tool.call.arguments"] as string
  expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(32768)
  expect(() => JSON.parse(json)).not.toThrow()
  expect((JSON.parse(json) as { entries: string[] }).entries.length).toBeGreaterThan(0)
  expect(tool.attributes["exception.message"]).toBeUndefined()
  expect(tool.attributes["exception.stacktrace"]).toBe("private stack [redacted]")
  const privacy = new PrivacyPipeline(config.capture)
  expect(privacy.text("Authorization: BearerSecret password=hidden")).toBe("Authorization=[redacted] password=[redacted]")
  const unsupported = new Proxy({}, { ownKeys() { throw Error("private proxy") } })
  expect(JSON.parse(privacy.boundValue(unsupported))).toBe("[omitted: unsupported or oversized]")
  expect(JSON.parse(privacy.boundValue(42))).toBe(42)
  expect(JSON.parse(privacy.boundValue(null))).toBeNull()
  await telemetry.shutdown()
})
