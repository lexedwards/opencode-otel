import { Plugin } from "@opencode/plugin"
import { createRegistry, establishConfig, resolveConfig } from "./config"
import { createTelemetry, type ExecutionEvent, type ModelEvent, type PermissionEvent, type CompactionEvent, type SessionRelationEvent } from "./telemetry"
import { injectTraceHeaders } from "./propagation"

const registry = createRegistry()
let pipeline: ReturnType<typeof createTelemetry> | undefined
let lastPropagationDiagnostic = 0

function propagationFailure(): void {
  if (Date.now() - lastPropagationDiagnostic < 60_000) return
  lastPropagationDiagnostic = Date.now()
  console.info("[opencode-otel] Trace propagation unavailable; request unchanged")
}

export default Plugin.define({
  id: "opencode-otel",
  async setup(ctx) {
    const proposed = resolveConfig(ctx.options)
    const instance = establishConfig(registry, proposed)
    for (const diagnostic of proposed.diagnostics) console.info(`[opencode-otel] ${diagnostic}`)
    if (instance.diagnostic) console.info(`[opencode-otel] ${instance.diagnostic}`)
    if (!pipeline && (instance.config.traces || instance.config.metrics)) {
      try {
        const created = createTelemetry(instance.config, ctx.app.version)
        if (created.traces || created.metrics) pipeline = created
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
      if (instance.config.propagateTraceContext) {
        const registrations: { dispose(): Promise<void> }[] = []
        try {
          registrations.push(await ctx.session.hook("http.request", (event) => {
            try {
              const context = pipeline?.execution.contextForRequest(event.sessionID, event.kind, event.model)
              if (context) injectTraceHeaders(event.request.headers, context)
            } catch { propagationFailure() }
          }))
          registrations.push(await ctx.session.hook("experimental.ws.handshake", (event) => {
            try {
              const context = pipeline?.execution.contextForRequest(event.sessionID, event.kind, event.model)
              if (context) injectTraceHeaders(event.headers, context)
            } catch { propagationFailure() }
          }))
          hooks.push(...registrations)
        } catch {
          for (const registration of registrations) { try { await registration.dispose() } catch { /* fail open */ } }
          propagationFailure()
        }
      }
      if (Object.entries(instance.config.capture).some(([key, value]) => !key.startsWith("redact") && value === true)) {
        const registrations: { dispose(): Promise<void> }[] = []
        try {
          registrations.push(await ctx.session.hook("context", (event) => {
            try { pipeline?.execution.captureContext(event, "primary") } catch { /* fail open */ }
          }))
          registrations.push(await ctx.session.hook("compaction", (event) => {
            try { pipeline?.execution.captureContext(event, "compaction") } catch { /* fail open */ }
          }))
          hooks.push(...registrations)
        } catch {
          for (const registration of registrations) { try { await registration.dispose() } catch { /* fail open */ } }
          console.info("[opencode-otel] Content capture hooks unavailable; capture disabled")
        }
      }
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const eventType: string = event.type
            if (!(eventType.startsWith("session.execution.") || eventType.startsWith("session.step.") || ["session.compaction.started", "session.compaction.ended", "session.compaction.failed"].includes(eventType) || eventType === "session.retry.scheduled" || eventType === "session.created" || eventType === "session.forked" || eventType === "session.text.ended" || eventType === "permission.asked" || eventType === "permission.replied")) continue
            if (event.location?.directory && event.location.directory !== ctx.location.directory) continue
            try {
              if (event.type.startsWith("session.execution.")) pipeline?.execution.onEvent(event as ExecutionEvent, ctx.location.project.id)
              else if (event.type === "session.created" || event.type === "session.forked") pipeline?.execution.onSessionRelation(event as SessionRelationEvent)
              else if (event.type.startsWith("permission.")) pipeline?.execution.onPermissionEvent(event as PermissionEvent)
              else if (eventType === "session.text.ended") pipeline?.execution.onTextEnded(event as { type: "session.text.ended"; data: { sessionID: string; assistantMessageID: string; ordinal: number; text: string } })
              else if (event.type.startsWith("session.compaction.")) pipeline?.execution.onCompactionEvent(event as CompactionEvent)
              else pipeline?.execution.onModelEvent(event as ModelEvent)
            } catch { /* fail open */ }
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
