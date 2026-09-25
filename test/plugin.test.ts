import { expect, test, spyOn } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"

test("plugin entrypoint reports inactivity once and cleans up", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {})
  try {
    expect(plugin.id).toBe("opencode-otel")
    const cleanup = await plugin.setup({ options: {} } as unknown as Plugin.Context)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[0]).toContain("[opencode-otel] No OTLP endpoint configured")
    if (cleanup) await cleanup()
  } finally {
    info.mockRestore()
  }
})

test("matching locations share one pipeline and only the final unload closes it", async () => {
  const shutdown = spyOn(OTLPTraceExporter.prototype, "shutdown")
  const ctx = {
    app: { version: "2.0.16" },
    options: { traces: { endpoint: "https://collector.test/v1/traces" } },
    location: { directory: "/workspace", project: { id: "opaque-project" } },
    tool: { async hook() { return { async dispose() {} } } },
    event: { subscribe({ signal }: { signal: AbortSignal }) {
      return { async *[Symbol.asyncIterator]() { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) } }
    } },
  } as unknown as Plugin.Context
  try {
    const first = await plugin.setup(ctx)
    const second = await plugin.setup(ctx)
    if (first) await first()
    expect(shutdown).not.toHaveBeenCalled()
    if (second) await second()
    expect(shutdown).toHaveBeenCalledTimes(1)
  } finally {
    shutdown.mockRestore()
  }
})

test("provider request hooks are opt-in, propagate an active model context, and fail open", async () => {
  const registered = new Map<string, (event: any) => void>()
  const diagnostics = spyOn(console, "info").mockImplementation(() => {})
  const exportSpans = spyOn(OTLPTraceExporter.prototype, "export").mockImplementation((_spans, callback) => callback({ code: 0 }))
  const context = (propagateTraceContext: boolean) => ({
    app: { version: "2.0.16" },
    options: { traces: { endpoint: "https://collector.test/v1/traces" }, propagateTraceContext },
    location: { directory: "/workspace", project: { id: "opaque-project" } },
    tool: { async hook() { return { async dispose() {} } } },
    session: { async hook(name: string, callback: (event: any) => void) {
      registered.set(name, callback)
      return { async dispose() { registered.delete(name) } }
    } },
    event: { subscribe({ signal }: { signal: AbortSignal }) {
      return { async *[Symbol.asyncIterator]() {
        yield { type: "session.execution.started", id: "root", created: 1000, data: { sessionID: "session-1" } }
        yield { type: "session.step.started", id: "model-start", created: 1100, data: { sessionID: "session-1", assistantMessageID: "msg", model: { id: "model", providerID: "openai" } } }
        await new Promise<void>((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }))
      } }
    } },
  }) as unknown as Plugin.Context
  try {
    const defaultCleanup = await plugin.setup(context(false))
    expect(registered.size).toBe(0)
    if (defaultCleanup) await defaultCleanup()

    const cleanup = await plugin.setup(context(true))
    try {
      expect([...registered.keys()].sort()).toEqual(["experimental.ws.handshake", "http.request"])
      for (let i = 0; i < 8; i++) await Promise.resolve()
      const http = registered.get("http.request")!
      const request = new Request("https://provider.test", { headers: { authorization: "Bearer private" } })
      http({ sessionID: "session-1", kind: "primary", model: { id: "model", providerID: "openai" }, request })
      expect(request.headers.get("traceparent")).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/)
      expect(request.headers.get("authorization")).toBe("Bearer private")
      const unsupported = new Request("https://provider.test")
      http({ sessionID: "other", kind: "primary", model: { id: "model", providerID: "openai" }, request: unsupported })
      expect(unsupported.headers.has("traceparent")).toBe(false)
      const ws = registered.get("experimental.ws.handshake")!
      const headers: Record<string, string> = {}
      ws({ sessionID: "session-1", kind: "primary", model: { id: "model", providerID: "openai" }, headers })
      expect(headers.traceparent).toBe(request.headers.get("traceparent")!)
      http({ sessionID: "session-1", kind: "primary", model: { id: "model", providerID: "openai" }, request: { headers: new Proxy({}, { ownKeys() { throw Error("private request") } }) } })
      expect(diagnostics.mock.calls.map((call) => call[0])).toEqual(["[opencode-otel] Trace propagation unavailable; request unchanged"])
    } finally { if (cleanup) await cleanup() }
    expect(registered.size).toBe(0)
  } finally { diagnostics.mockRestore(); exportSpans.mockRestore() }
})
