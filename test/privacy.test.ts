import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import Ajv from "ajv"
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { resolveConfig } from "../src/config"
import { PrivacyPipeline } from "../src/privacy"
import { createTelemetry } from "../src/telemetry"

test("capture categories default off, umbrella enables them, and granular opt-outs win", () => {
  expect(Object.values(resolveConfig({}, {}).capture).slice(0, 4)).toEqual([false, false, false, false])
  const capture = resolveConfig({}, { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }).capture
  expect([capture.inputMessages, capture.outputMessages, capture.systemInstructions, capture.toolDefinitions]).toEqual([true, true, true, true])
  expect(resolveConfig({ capture: { outputMessages: false, toolDefinitions: false } }, { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }).capture).toMatchObject({ inputMessages: true, outputMessages: false, systemInstructions: true, toolDefinitions: false })
  const invalid = resolveConfig({}, { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" })
  expect(invalid.capture.outputMessages).toBe(true)
  const rejected = resolveConfig({ capture: { redactPatterns: ["["] } }, {})
  expect(rejected.capture.inputMessages).toBe(false)
  expect(rejected.diagnostics.join(" ")).not.toContain("[")
})

test("redaction precedes UTF-8 bounding, retains valid recent messages, and excludes binary", () => {
  const pipeline = new PrivacyPipeline({ inputMessages: true, outputMessages: true, systemInstructions: true, toolDefinitions: true, toolArguments: false, toolResults: false, errorMessages: false, stackTraces: false, redactKeys: ["sessionSecret"], redactPatterns: ["bearer-[0-9]+"] })
  const value = pipeline.value({ nested: { password: "hidden", sessionSecret: "hidden-again", data: "bearer-1234", safe: "🦊".repeat(3000) } }) as Record<string, any>
  expect(JSON.stringify(value)).not.toMatch(/hidden|bearer-1234/)
  expect(value.nested.data).toBe("[binary omitted]")
  expect(new TextEncoder().encode(value.nested.safe).length).toBeLessThanOrEqual(4096)
  expect(value.nested.safe.endsWith("[truncated]")).toBe(true)
  const messages = pipeline.messages([{ role: "user", content: [
    { type: "text", text: "hello" },
    { type: "media", media: { source: { type: "bytes", data: new Uint8Array([1, 2]), mediaType: "image/png" } } },
    { type: "media", media: { source: { type: "base64", data: "INLINE_BINARY", mediaType: "audio/wav" } } },
    { type: "media", media: { source: { type: "url", url: "https://user:password@example.test/image.png?apiKey=secret#private", mediaType: "image/png" } } },
    { type: "media", media: { source: { type: "ref", id: "file-1", mediaType: "audio/wav" } } },
  ] }])
  expect(messages[0]?.parts).toEqual([
    { type: "text", content: "hello" },
    { type: "uri", modality: "image", mime_type: "image/png", uri: "https://example.test/image.png" },
    { type: "file", modality: "audio", mime_type: "audio/wav", file_id: "file-1" },
  ])
  expect(JSON.stringify(messages)).not.toContain("INLINE_BINARY")
  expect(JSON.stringify(messages)).not.toMatch(/password|apiKey|secret|private/)
  const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", parts: [{ type: "text", content: `${i}:` + "a".repeat(3500) }] }))
  const bound = pipeline.bound(many, true)
  const retained = JSON.parse(bound.json) as typeof many
  expect(new TextEncoder().encode(bound.json).length).toBeLessThanOrEqual(32768)
  expect(bound.omittedMessages).toBeGreaterThan(0)
  expect(bound.omittedBytes).toBeGreaterThan(0)
  expect(retained.at(-1)?.parts[0]?.content.startsWith("19:")).toBe(true)
  expect(retained[0]?.parts[0]?.content.startsWith("0:")).toBe(false)
})

test("default telemetry never emits model content even when content events are observed", async () => {
  const spans = new InMemorySpanExporter()
  const telemetry = createTelemetry(resolveConfig({ endpoint: "https://collector.test" }, {}), "2.0.16", { traces: spans })
  const coordinator = telemetry.execution
  coordinator.onEvent({ type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" } }, "project")
  coordinator.captureContext({ sessionID: "session", model: { id: "model", providerID: "openai" }, system: [{ type: "text", text: "private system" }], messages: [{ role: "user", content: [{ type: "text", text: "private input" }] }], tools: { secret: { description: "private definition" } } }, "primary")
  coordinator.onModelEvent({ type: "session.step.started", id: "start", created: 1100, data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } })
  coordinator.onTextEnded({ type: "session.text.ended", data: { sessionID: "session", assistantMessageID: "msg", ordinal: 0, text: "private output" } })
  coordinator.onModelEvent({ type: "session.step.ended", id: "end", created: 1500, data: { sessionID: "session", assistantMessageID: "msg" } })
  coordinator.onEvent({ type: "session.execution.succeeded", id: "root-end", created: 2000, data: { sessionID: "session" } }, "project")
  await telemetry.traces?.forceFlush()
  expect(JSON.stringify(spans.getFinishedSpans().map((span) => span.attributes))).not.toContain("private")
  await telemetry.shutdown()
})

test("primary and compaction content attach only to their model spans when selected", async () => {
  const spans = new InMemorySpanExporter()
  const config = resolveConfig({ endpoint: "https://collector.test", capture: { inputMessages: true, outputMessages: true, systemInstructions: true, toolDefinitions: true, redactKeys: ["apiKey"] } }, {})
  const telemetry = createTelemetry(config, "2.0.16", { traces: spans })
  const coordinator = telemetry.execution
  coordinator.onEvent({ type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session" } }, "project")
  coordinator.captureContext({ sessionID: "session", model: { id: "model", providerID: "openai" }, system: [{ type: "text", text: "system-safe" }], messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "tool-call", name: "search", input: { apiKey: "secret-key" } }] }], tools: { search: { description: "look up", input: { properties: { apiKey: { default: "secret-key" } } } } } }, "primary")
  coordinator.onModelEvent({ type: "session.step.started", id: "start", created: 1100, data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } })
  coordinator.onTextEnded({ type: "session.text.ended", data: { sessionID: "session", assistantMessageID: "msg", ordinal: 0, text: "answer" } })
  coordinator.onModelEvent({ type: "session.step.ended", id: "end", created: 1500, data: { sessionID: "session", assistantMessageID: "msg" } })
  coordinator.onCompactionEvent({ type: "session.compaction.started", id: "compact-start", created: 1600, data: { sessionID: "session", reason: "auto" } })
  coordinator.captureContext({ sessionID: "session", model: { id: "model", providerID: "openai" }, system: [], messages: [{ role: "user", content: [{ type: "text", text: "incomplete transcript" }] }] }, "compaction")
  coordinator.onCompactionEvent({ type: "session.compaction.ended", id: "compact-end", created: 1900, data: { sessionID: "session", reason: "auto", text: "summary-safe", recent: "private recent" } })
  coordinator.onEvent({ type: "session.execution.succeeded", id: "root-end", created: 2000, data: { sessionID: "session" } }, "project")
  await telemetry.traces?.forceFlush()
  const all = spans.getFinishedSpans()
  const root = all.find((span) => span.name === "invoke_agent")!
  const model = all.find((span) => span.name === "chat model")!
  const compact = all.find((span) => span.attributes["opencode.model.kind"] === "compaction")!
  expect(Object.keys(root.attributes).some((key) => key.includes("messages") || key.includes("definitions") || key.includes("instructions"))).toBe(false)
  expect(JSON.parse(model.attributes["gen_ai.input.messages"] as string)).toEqual([{ role: "user", parts: [{ type: "text", content: "hello" }, { type: "tool_call", name: "search", arguments: { apiKey: "[redacted]" } }] }])
  expect(JSON.parse(model.attributes["gen_ai.output.messages"] as string)).toEqual([{ role: "assistant", parts: [{ type: "text", content: "answer" }], finish_reason: "unknown" }])
  expect(JSON.parse(model.attributes["gen_ai.system_instructions"] as string)).toEqual([{ type: "text", content: "system-safe" }])
  expect(JSON.parse(model.attributes["gen_ai.tool.definitions"] as string)).toMatchObject([{ type: "function", name: "search" }])
  expect(compact.attributes["gen_ai.input.messages"]).toBeUndefined()
  expect(JSON.parse(compact.attributes["gen_ai.output.messages"] as string)).toEqual([{ role: "assistant", parts: [{ type: "text", content: "summary-safe" }], finish_reason: "stop" }])
  expect(JSON.stringify(all.map((span) => span.attributes))).not.toMatch(/secret-key|incomplete transcript|private recent/)
  const ajv = new Ajv({ strict: false, validateFormats: false })
  for (const [attribute, filename] of [["gen_ai.input.messages", "input-messages"], ["gen_ai.output.messages", "output-messages"], ["gen_ai.system_instructions", "system-instructions"]] as const) {
    const schema = JSON.parse(readFileSync(new URL(`./fixtures/gen-ai/${filename}.json`, import.meta.url), "utf8"))
    expect({ attribute, valid: ajv.validate(schema, JSON.parse(model.attributes[attribute] as string)), errors: ajv.errors }).toMatchObject({ valid: true })
    if (attribute === "gen_ai.output.messages") expect(ajv.validate(schema, JSON.parse(compact.attributes[attribute] as string))).toBe(true)
  }
  await telemetry.shutdown()
})

test("large captured input remains schema-valid on the span with oldest-message omission counts", async () => {
  const spans = new InMemorySpanExporter()
  const telemetry = createTelemetry(resolveConfig({ endpoint: "https://collector.test", capture: { inputMessages: true } }, {}), "2.0.16", { traces: spans })
  const c = telemetry.execution
  c.onEvent({ type: "session.execution.started", id: "start", created: 1000, data: { sessionID: "session" } }, "project")
  c.captureContext({ sessionID: "session", model: { id: "model", providerID: "openai" }, system: [], messages: Array.from({ length: 20 }, (_, index) => ({ role: "user", content: [{ type: "text", text: `${index}:` + "z".repeat(3500) }] })) }, "primary")
  c.onModelEvent({ type: "session.step.started", id: "step", created: 1100, data: { sessionID: "session", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } })
  c.onModelEvent({ type: "session.step.ended", id: "end", created: 1300, data: { sessionID: "session", assistantMessageID: "msg" } })
  c.onEvent({ type: "session.execution.succeeded", id: "end-root", created: 1400, data: { sessionID: "session" } }, "project")
  await telemetry.traces?.forceFlush()
  const attributes = spans.getFinishedSpans().find((span) => span.name === "chat model")!.attributes
  const json = attributes["gen_ai.input.messages"] as string
  expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(32768)
  expect(attributes["opencode.gen_ai.input.messages.omitted_messages"]).toBeGreaterThan(0)
  expect(attributes["opencode.gen_ai.input.messages.omitted_bytes"]).toBeGreaterThan(0)
  const messages = JSON.parse(json) as Array<{ role: string; parts: Array<{ content: string }> }>
  expect(messages.at(-1)?.parts[0]?.content.startsWith("19:")).toBe(true)
  const schema = JSON.parse(readFileSync(new URL("./fixtures/gen-ai/input-messages.json", import.meta.url), "utf8"))
  expect(new Ajv({ strict: false, validateFormats: false }).validate(schema, messages)).toBe(true)
  await telemetry.shutdown()
})
