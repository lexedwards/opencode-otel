import { randomUUID } from "node:crypto"
import { SpanKind, SpanStatusCode, ROOT_CONTEXT, trace, type Span, type Tracer, type Meter } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base"
import type { Config, SignalConfig } from "./config"

export type ExecutionEvent = {
  id: string
  created: number
  type: "session.execution.started" | "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
  location?: { workspaceID?: string; directory?: string }
  data: { sessionID: string; error?: { type: string; message: string; status?: number }; reason?: string }
}

type ToolState = { started: number; span?: Span }
type Active = { id: string; started: number; span?: Span; tools: Map<string, ToolState>; completedTools: Set<string>; toolCalls: number }

export type ToolEvent = { sessionID: string; id: string; tool: string; status?: "completed" | "error"; input?: unknown; result?: unknown; error?: unknown }

export class ExecutionTelemetry {
  private readonly active = new Map<string, Active>()
  private readonly seen = new Map<string, number>()
  private readonly histogram?: ReturnType<Meter["createHistogram"]>
  private readonly toolDuration?: ReturnType<Meter["createHistogram"]>
  private readonly toolCalls?: ReturnType<Meter["createHistogram"]>
  private lastDroppedDiagnostic = 0

  constructor(private readonly tracer?: Tracer, meter?: Meter, private readonly now: () => number = Date.now) {
    this.histogram = meter?.createHistogram("gen_ai.invoke_agent.duration", { unit: "s", description: "Agent invocation duration" })
    this.toolDuration = meter?.createHistogram("gen_ai.execute_tool.duration", { unit: "s", description: "Tool execution duration" })
    this.toolCalls = meter?.createHistogram("gen_ai.invoke_agent.tool_calls", { unit: "{call}", description: "Tool calls per agent invocation" })
  }

  onEvent(event: ExecutionEvent, projectID: string): void {
    const session = event.data.sessionID
    if (event.type === "session.execution.started") {
      if (this.seen.has(event.id) || this.active.has(session)) return
      if (this.active.size >= 2048) {
        if (Date.now() - this.lastDroppedDiagnostic > 60_000) {
          this.lastDroppedDiagnostic = Date.now()
          console.info("[opencode-otel] Execution telemetry capacity reached; dropping records")
        }
        return
      }
      this.seen.set(event.id, event.created)
      if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!)
      const attributes: Record<string, string> = { "gen_ai.operation.name": "invoke_agent", "opencode.project.id": projectID }
      if (event.location?.workspaceID) attributes["opencode.workspace.id"] = event.location.workspaceID
      const span = this.tracer?.startSpan("invoke_agent", { kind: SpanKind.INTERNAL, attributes, startTime: event.created }, ROOT_CONTEXT)
      this.active.set(session, { id: event.id, started: event.created, span, tools: new Map(), completedTools: new Set(), toolCalls: 0 })
      return
    }
    const execution = this.active.get(session)
    if (!execution) return
    this.active.delete(session)
    for (const tool of execution.tools.values()) {
      tool.span?.setAttribute("opencode.tool.outcome", "abandoned")
      tool.span?.end(event.created)
    }
    this.toolCalls?.record(execution.toolCalls, { "gen_ai.operation.name": "invoke_agent" })
    const outcome = event.type.slice("session.execution.".length)
    const duration = Math.max(0, (event.created - execution.started) / 1000)
    const attrs = { "gen_ai.operation.name": "invoke_agent", "error.type": event.type === "session.execution.failed" ? safeErrorType(event.data.error?.type) : undefined }
    this.histogram?.record(duration, attrs)
    execution.span?.setAttribute("opencode.execution.outcome", outcome)
    if (event.type === "session.execution.failed") {
      execution.span?.setStatus({ code: SpanStatusCode.ERROR })
      execution.span?.setAttribute("error.type", safeErrorType(event.data.error?.type))
      if (event.data.error?.status !== undefined) execution.span?.setAttribute("opencode.error.status", event.data.error.status)
    } else if (event.type === "session.execution.interrupted") {
      execution.span?.setStatus({ code: SpanStatusCode.ERROR })
    } else execution.span?.setStatus({ code: SpanStatusCode.OK })
    execution.span?.end(event.created)
  }

  toolBefore(event: ToolEvent): void {
    const execution = this.active.get(event.sessionID)
    if (!execution || execution.tools.has(event.id) || execution.completedTools.has(event.id) || execution.tools.size >= 2048) return
    const started = this.now()
    const parent = execution.span ? trace.setSpan(ROOT_CONTEXT, execution.span) : ROOT_CONTEXT
    const span = this.tracer && execution.span ? this.tracer.startSpan("execute_tool", {
      kind: SpanKind.INTERNAL,
      attributes: { "gen_ai.operation.name": "execute_tool" },
      startTime: started,
    }, parent) : undefined
    execution.tools.set(event.id, { started, span })
  }

  toolAfter(event: ToolEvent): void {
    const execution = this.active.get(event.sessionID)
    const tool = execution?.tools.get(event.id)
    if (!execution || !tool) return
    execution.tools.delete(event.id)
    execution.completedTools.add(event.id)
    const ended = this.now()
    const outcome = event.status === "error" ? "error" : "completed"
    execution.toolCalls++
    this.toolDuration?.record(Math.max(0, (ended - tool.started) / 1000), { "gen_ai.operation.name": "execute_tool", "error.type": outcome === "error" ? "tool.error" : undefined })
    tool.span?.setAttribute("opencode.tool.outcome", outcome)
    if (outcome === "error") tool.span?.setAttribute("error.type", "tool.error")
    tool.span?.setStatus({ code: outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK })
    tool.span?.end(ended)
  }

  end(): void {
    for (const execution of this.active.values()) {
      for (const tool of execution.tools.values()) tool.span?.end()
      execution.span?.setAttribute("opencode.execution.outcome", "abandoned")
      execution.span?.end()
    }
    this.active.clear()
    this.seen.clear()
  }
}

function safeErrorType(type?: string): string {
  // Arbitrary provider error types may themselves contain content or high-cardinality identifiers.
  return type && new Set(["provider.timeout", "provider.rate-limit", "provider.invalid-request", "provider.auth", "context.overflow"]).has(type) ? type : "unknown"
}

export type Exporters = { traces?: SpanExporter; metrics?: PushMetricExporter }
export function makeExporters(config: Config): Exporters {
  const result: Exporters = {}
  let lastFailure = 0
  const diagnostic = () => {
    if (Date.now() - lastFailure < 60_000) return
    lastFailure = Date.now()
    console.info("[opencode-otel] OTLP export failed; telemetry may be dropped")
  }
  const options = (signal: SignalConfig) => ({
    url: signal.endpoint,
    headers: signal.headers,
    timeoutMillis: signal.timeoutMillis,
    compression: signal.compression === "gzip" ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE,
    ...(signal.certificate || signal.clientCertificate ? { httpAgentOptions: { ca: signal.certificate, cert: signal.clientCertificate, key: signal.clientKey } } : {}),
  })
  if (config.traces?.protocol === "http/protobuf") {
    const exporter = new OTLPTraceExporter(options(config.traces))
    result.traces = {
      export(spans, callback) {
        try { exporter.export(spans, (result) => { if (result.code !== 0) diagnostic(); callback(result) }) }
        catch { diagnostic(); callback({ code: 1 }) }
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush(),
    }
  }
  if (config.metrics?.protocol === "http/protobuf") {
    const exporter = new OTLPMetricExporter(options(config.metrics))
    result.metrics = {
      export(metrics, callback) {
        try { exporter.export(metrics, (result) => { if (result.code !== 0) diagnostic(); callback(result) }) }
        catch { diagnostic(); callback({ code: 1 }) }
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush(),
      selectAggregationTemporality: (type) => exporter.selectAggregationTemporality(type),
    }
  }
  return result
}

const instanceID = randomUUID()
export function createTelemetry(config: Config, version: string, exporters: Exporters = makeExporters(config), shutdownTimeoutMillis = 5000, now: () => number = Date.now) {
  const resource = resourceFromAttributes({ "service.name": "opencode", "service.version": version, "service.instance.id": instanceID })
  const traces = exporters.traces ? new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(exporters.traces, { maxQueueSize: 2048, maxExportBatchSize: 512 })] }) : undefined
  const metrics = exporters.metrics ? new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: exporters.metrics })] }) : undefined
  const execution = new ExecutionTelemetry(traces?.getTracer("opencode-otel"), metrics?.getMeter("opencode-otel"), now)
  return {
    execution,
    traces,
    metrics,
    async shutdown() {
      execution.end()
      // SDK shutdown can wait on network I/O. Bound plugin unload independently.
      const work = Promise.allSettled([traces?.shutdown(), metrics?.shutdown()])
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, shutdownTimeoutMillis); timer.unref?.() })])
      if (timer) clearTimeout(timer)
    },
  }
}
