import { Plugin } from "@opencode/plugin"
import { createRegistry, establishConfig, resolveConfig } from "./config"
import { createTelemetry, type ExecutionEvent } from "./telemetry"

const registry = createRegistry()
let pipeline: ReturnType<typeof createTelemetry> | undefined

export default Plugin.define({
  id: "opencode-otel",
  async setup(ctx) {
    const proposed = resolveConfig(ctx.options)
    const instance = establishConfig(registry, proposed)
    for (const diagnostic of proposed.diagnostics) console.info(`[opencode-otel] ${diagnostic}`)
    if (instance.diagnostic) console.info(`[opencode-otel] ${instance.diagnostic}`)
    for (const signal of ["traces", "metrics"] as const) {
      if (instance.config[signal] && instance.config[signal].protocol !== "http/protobuf") console.info(`[opencode-otel] ${signal} transport is not implemented yet; signal disabled`)
    }
    if (!pipeline && (instance.config.traces?.protocol === "http/protobuf" || instance.config.metrics?.protocol === "http/protobuf")) {
      try {
        pipeline = createTelemetry(instance.config, ctx.app.version)
      } catch {
        console.info("[opencode-otel] Telemetry initialization failed; export disabled")
      }
    }
    const controller = new AbortController()
    const hooks: { dispose(): Promise<void> }[] = []
    if (pipeline) {
      try {
        hooks.push(await ctx.tool.hook("execute.before", (event) => { try { pipeline?.execution.toolBefore(event) } catch { /* fail open */ } }))
        hooks.push(await ctx.tool.hook("execute.after", (event) => { try { pipeline?.execution.toolAfter(event) } catch { /* fail open */ } }))
      } catch {
        console.info("[opencode-otel] Tool hooks unavailable; tool telemetry disabled")
        for (const hook of hooks) await hook.dispose()
      }
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (typeof event.type !== "string" || !event.type.startsWith("session.execution.")) continue
            if (event.location?.directory && event.location.directory !== ctx.location.directory) continue
            try { pipeline?.execution.onEvent(event as ExecutionEvent, ctx.location.project.id) } catch { /* fail open */ }
          }
        } catch {
          if (!controller.signal.aborted) console.info("[opencode-otel] Event subscription stopped; telemetry unavailable")
        }
      })()
    }
    return async () => {
      controller.abort()
      for (const hook of hooks) { try { await hook.dispose() } catch { /* fail open */ } }
      instance.release()
      if (registry.users === 0) {
        const current = pipeline
        pipeline = undefined
        try { await current?.shutdown() } catch { /* fail open */ }
      }
    }
  },
})
