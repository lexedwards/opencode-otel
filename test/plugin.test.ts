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
