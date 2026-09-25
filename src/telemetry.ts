import { randomUUID } from "node:crypto"
import { SpanKind, SpanStatusCode, ROOT_CONTEXT, trace, type Span, type SpanContext, type Tracer, type Meter } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter as JsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { createEmptyMetadata, createInsecureCredentials, createSslCredentials } from "@opentelemetry/otlp-grpc-exporter-base"
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base"
import { exporterSecrets, type Config, type SignalConfig } from "./config"

export type ExecutionEvent = {
  id: string
  created: number
  type: "session.execution.started" | "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
  location?: { workspaceID?: string; directory?: string }
  data: { sessionID: string; error?: { type: string; message: string; status?: number }; reason?: string }
}

export type ModelEvent = {
  id: string
  created: number
  type: "session.step.started" | "session.step.streamed" | "session.step.ended" | "session.step.failed" | "session.retry.scheduled"
  location?: { directory?: string }
  data: {
    sessionID: string
    assistantMessageID: string
    started?: number
    model?: { id: string; providerID: string }
    attempt?: number
    error?: { type: string; message: string; status?: number }
    finish?: string
    cost?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  }
}

export type PermissionEvent = {
  id: string
  created: number
  type: "permission.asked" | "permission.replied"
  location?: { directory?: string }
  data: { sessionID: string; id?: string; action?: string; requestID?: string; reply?: "once" | "always" | "reject"; resources?: string[]; message?: string; metadata?: unknown; save?: string[] }
}

export type CompactionEvent = {
  id: string
  created: number
  type: "session.compaction.started" | "session.compaction.ended" | "session.compaction.failed"
  location?: { directory?: string }
  data: { sessionID: string; reason: "auto" | "manual"; model?: { id: string; providerID: string }; cost?: number; tokens?: ModelEvent["data"]["tokens"]; error?: { type: string; message: string }; recent?: string; text?: string }
}
export type SessionRelationEvent = { id: string; created: number; type: "session.created" | "session.forked"; location?: { directory?: string }; data: { sessionID: string; parentID?: string; title?: string } }

type ToolState = { started: number; span?: Span }
type ModelState = { started: number; span?: Span; provider: string; model: string; firstChunk?: number; retries: number; retryEvents: Set<string> }
type CompactionState = { started: number; model: ModelState; execution?: Active }
type Active = { id: string; started: number; span?: Span; tools: Map<string, ToolState>; completedTools: Set<string>; toolCalls: number; models: Map<string, ModelState>; completedModels: Set<string>; inferenceCalls: number; permissions: Map<string, { started: number; action: string }>; completedPermissions: Set<string> }

export type ToolEvent = { sessionID: string; id: string; tool: string; status?: "completed" | "error"; input?: unknown; result?: unknown; error?: unknown }

export class ExecutionTelemetry {
  private readonly active = new Map<string, Active>()
  private readonly compactions = new Map<string, CompactionState>()
  private readonly compactionSeen = new Set<string>()
  private readonly parents = new Map<string, { parentID: string; created: number; context?: SpanContext }>()
  private readonly pendingTerminals = new Map<string, ExecutionEvent | ModelEvent | CompactionEvent>()
  private readonly seen = new Map<string, number>()
  private readonly histogram?: ReturnType<Meter["createHistogram"]>
  private readonly toolDuration?: ReturnType<Meter["createHistogram"]>
  private readonly toolCalls?: ReturnType<Meter["createHistogram"]>
  private readonly modelDuration?: ReturnType<Meter["createHistogram"]>
  private readonly firstChunk?: ReturnType<Meter["createHistogram"]>
  private readonly tokenUsage?: ReturnType<Meter["createHistogram"]>
  private readonly inferenceCalls?: ReturnType<Meter["createHistogram"]>
  private readonly cost?: ReturnType<Meter["createCounter"]>
  private readonly retryCount?: ReturnType<Meter["createCounter"]>
  private readonly permissionRequests?: ReturnType<Meter["createCounter"]>
  private readonly permissionReplies?: ReturnType<Meter["createCounter"]>
  private readonly permissionWait?: ReturnType<Meter["createHistogram"]>
  private lastDroppedDiagnostic = 0
  private lastPermissionDiagnostic = 0

  constructor(private readonly tracer?: Tracer, meter?: Meter, private readonly now: () => number = Date.now, private readonly providerNames: Record<string, string> = {}, private readonly expiryMillis = 24 * 60 * 60_000) {
    this.histogram = meter?.createHistogram("gen_ai.invoke_agent.duration", { unit: "s", description: "Agent invocation duration" })
    this.toolDuration = meter?.createHistogram("gen_ai.execute_tool.duration", { unit: "s", description: "Tool execution duration" })
    this.toolCalls = meter?.createHistogram("gen_ai.invoke_agent.tool_calls", { unit: "{call}", description: "Tool calls per agent invocation" })
    this.modelDuration = meter?.createHistogram("gen_ai.client.operation.duration", { unit: "s" })
    this.firstChunk = meter?.createHistogram("gen_ai.client.operation.time_to_first_chunk", { unit: "s" })
    this.tokenUsage = meter?.createHistogram("gen_ai.client.token.usage", { unit: "{token}" })
    this.inferenceCalls = meter?.createHistogram("gen_ai.invoke_agent.inference_calls", { unit: "{call}" })
    this.cost = meter?.createCounter("opencode.gen_ai.cost", { unit: "USD" })
    this.retryCount = meter?.createCounter("opencode.gen_ai.retry.count", { unit: "{retry}" })
    this.permissionRequests = meter?.createCounter("opencode.permission.request.count", { unit: "{request}" })
    this.permissionReplies = meter?.createCounter("opencode.permission.reply.count", { unit: "{reply}" })
    this.permissionWait = meter?.createHistogram("opencode.permission.wait.duration", { unit: "s" })
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
      const relation = this.parents.get(session)
      this.parents.delete(session)
      const parentContext = relation && (this.active.get(relation.parentID)?.span?.spanContext() ?? relation.context)
      const span = this.tracer?.startSpan("invoke_agent", { kind: SpanKind.INTERNAL, attributes, startTime: event.created, links: parentContext ? [{ context: parentContext }] : [] }, ROOT_CONTEXT)
      this.active.set(session, { id: event.id, started: event.created, span, tools: new Map(), completedTools: new Set(), toolCalls: 0, models: new Map(), completedModels: new Set(), inferenceCalls: 0, permissions: new Map(), completedPermissions: new Set() })
      const terminal = this.takeTerminal<ExecutionEvent>(`execution:${session}`, event.created)
      if (terminal) this.onEvent(terminal, projectID)
      return
    }
    const execution = this.active.get(session)
    if (!execution) { this.bufferTerminal(`execution:${session}`, event); return }
    this.active.delete(session)
    for (const tool of execution.tools.values()) {
      tool.span?.setAttribute("opencode.tool.outcome", "abandoned")
      tool.span?.end(event.created)
    }
    for (const model of execution.models.values()) {
      model.span?.setStatus({ code: SpanStatusCode.ERROR })
      model.span?.setAttribute("opencode.model.outcome", "abandoned")
      model.span?.end(event.created)
    }
    const compaction = this.compactions.get(session)
    if (compaction?.execution === execution) {
      compaction.model.span?.setAttribute("opencode.model.outcome", "abandoned")
      compaction.model.span?.end(event.created)
      this.compactions.delete(session)
    }
    this.toolCalls?.record(execution.toolCalls, { "gen_ai.operation.name": "invoke_agent" })
    this.inferenceCalls?.record(execution.inferenceCalls, { "gen_ai.operation.name": "invoke_agent" })
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

  onSessionRelation(event: SessionRelationEvent): void {
    const parentID = event.data.parentID
    if (!parentID || this.parents.has(event.data.sessionID) || this.parents.size >= 4096) return
    this.parents.set(event.data.sessionID, { parentID, created: event.created, context: this.active.get(parentID)?.span?.spanContext() })
  }

  onPermissionEvent(event: PermissionEvent): void {
    const execution = this.active.get(event.data.sessionID)
    if (!execution) return
    const completed = execution.completedPermissions
    const pending = execution.permissions
    for (const [id, request] of pending) {
      if (event.created - request.started < 30 * 60_000) continue
      pending.delete(id)
      completed.add(id)
      this.permissionDiagnostic()
    }
    while (completed.size > 4096) completed.delete(completed.values().next().value!)
    const id = event.type === "permission.asked" ? event.data.id : event.data.requestID
    if (!id || completed.has(id)) return
    if (event.type === "permission.asked") {
      if (pending.has(id)) return
      if (pending.size >= 2048) { this.permissionDiagnostic(); return }
      const action = safePermissionAction(event.data.action)
      pending.set(id, { started: event.created, action })
      const attrs = { "opencode.permission.action": action }
      execution.span?.addEvent("opencode.permission.asked", attrs, event.created)
      this.permissionRequests?.add(1, attrs)
      return
    }
    const request = pending.get(id)
    if (!request) { this.permissionDiagnostic(); completed.add(id) }
    else {
      pending.delete(id)
      completed.add(id)
      const reply = event.data.reply
      if (reply === "once" || reply === "always" || reply === "reject") {
        const attrs = { "opencode.permission.action": request.action, "opencode.permission.reply": reply }
        execution.span?.addEvent("opencode.permission.replied", attrs, event.created)
        this.permissionReplies?.add(1, attrs)
        this.permissionWait?.record(Math.max(0, (event.created - request.started) / 1000), attrs)
      }
    }
    if (completed.size > 4096) completed.delete(completed.values().next().value!)
  }

  private permissionDiagnostic(): void {
    if (Date.now() - this.lastPermissionDiagnostic < 60_000) return
    this.lastPermissionDiagnostic = Date.now()
    console.info("[opencode-otel] Permission telemetry event unmatched, expired, or capacity reached")
  }

  expire(): void {
    const now = this.now()
    let expired = false
    for (const [session, execution] of this.active) {
      if (now - execution.started < this.expiryMillis) continue
      this.active.delete(session)
      for (const tool of execution.tools.values()) {
        tool.span?.setAttribute("opencode.tool.outcome", "abandoned")
        tool.span?.end(now)
      }
      for (const model of execution.models.values()) {
        model.span?.setAttribute("opencode.model.outcome", "abandoned")
        model.span?.end(now)
      }
      execution.span?.setAttribute("opencode.execution.outcome", "abandoned")
      execution.span?.end(now)
      expired = true
    }
    for (const [session, compaction] of this.compactions) {
      if (now - compaction.started < this.expiryMillis && (!compaction.execution || this.active.get(session) === compaction.execution)) continue
      compaction.model.span?.setAttribute("opencode.model.outcome", "abandoned")
      compaction.model.span?.end(now)
      this.compactions.delete(session)
      expired = true
    }
    for (const [session, relation] of this.parents) if (now - relation.created >= this.expiryMillis) this.parents.delete(session)
    for (const [key, event] of this.pendingTerminals) if (now - event.created >= this.expiryMillis) this.pendingTerminals.delete(key)
    if (expired && Date.now() - this.lastDroppedDiagnostic >= 60_000) {
      this.lastDroppedDiagnostic = Date.now()
      console.info("[opencode-otel] Stale telemetry operation abandoned")
    }
  }

  onModelEvent(event: ModelEvent): void {
    const execution = this.active.get(event.data.sessionID)
    if (!execution) return
    const id = event.data.assistantMessageID
    const key = `model:${event.data.sessionID}:${id}`
    if (event.type === "session.step.started") {
      if (execution.models.has(id) || execution.completedModels.has(id) || execution.models.size >= 2048 || !event.data.model) return
      const started = event.data.started ?? event.created
      const provider = Object.hasOwn(this.providerNames, event.data.model.providerID) ? this.providerNames[event.data.model.providerID] : providerName(event.data.model.providerID)
      const model = event.data.model.id
      const attrs = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": provider, "gen_ai.request.model": model }
      const parent = execution.span ? trace.setSpan(ROOT_CONTEXT, execution.span) : ROOT_CONTEXT
      const span = this.tracer && execution.span ? this.tracer.startSpan(`chat ${model}`, { kind: SpanKind.CLIENT, startTime: started, attributes: attrs }, parent) : undefined
      execution.models.set(id, { started, span, provider, model, retries: 0, retryEvents: new Set() })
      const terminal = this.takeTerminal<ModelEvent>(key, started)
      if (terminal) this.onModelEvent(terminal)
      return
    }
    const step = execution.models.get(id)
    if (!step) {
      if ((event.type === "session.step.ended" || event.type === "session.step.failed") && !execution.completedModels.has(id)) this.bufferTerminal(key, event)
      return
    }
    if (event.type === "session.retry.scheduled") {
      if (step.retryEvents.has(event.id)) return
      step.retryEvents.add(event.id)
      step.retries++
      step.span?.addEvent("opencode.gen_ai.retry", { "error.type": safeErrorType(event.data.error?.type) }, event.created)
      return
    }
    if (event.type === "session.step.streamed") {
      step.firstChunk ??= event.created
      return
    }
    execution.models.delete(id)
    execution.completedModels.add(id)
    if (execution.completedModels.size > 4096) execution.completedModels.delete(execution.completedModels.values().next().value!)
    execution.inferenceCalls++
    this.finishModel(step, event.created, event.type === "session.step.failed", event.data)
  }

  onCompactionEvent(event: CompactionEvent): void {
    if (event.type !== "session.compaction.started" && event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") return
    const session = event.data.sessionID
    if (event.type === "session.compaction.started") {
      if (this.compactionSeen.has(event.id) || this.compactions.has(session) || this.compactions.size >= 2048) return
      this.compactionSeen.add(event.id)
      if (this.compactionSeen.size > 4096) this.compactionSeen.delete(this.compactionSeen.values().next().value!)
      const execution = this.active.get(session)
      const parent = execution?.span ? trace.setSpan(ROOT_CONTEXT, execution.span) : ROOT_CONTEXT
      const span = this.tracer?.startSpan("chat", { kind: SpanKind.CLIENT, startTime: event.created, attributes: { "gen_ai.operation.name": "chat", "opencode.model.kind": "compaction" } }, parent)
      this.compactions.set(session, { started: event.created, execution, model: { started: event.created, span, provider: "unknown", model: "unknown", retries: 0, retryEvents: new Set() } })
      const terminal = this.takeTerminal<CompactionEvent>(`compaction:${session}`, event.created)
      if (terminal) this.onCompactionEvent(terminal)
      return
    }
    const compaction = this.compactions.get(session)
    if (!compaction) { this.bufferTerminal(`compaction:${session}`, event); return }
    if (event.created < compaction.started) return
    this.compactions.delete(session)
    const model = event.data.model
    if (model) {
      compaction.model.provider = Object.hasOwn(this.providerNames, model.providerID) ? this.providerNames[model.providerID] : providerName(model.providerID)
      compaction.model.model = model.id
      compaction.model.span?.updateName(`chat ${model.id}`)
      compaction.model.span?.setAttribute("gen_ai.request.model", model.id)
    }
    compaction.execution && compaction.execution.inferenceCalls++
    this.finishModel(compaction.model, event.created, event.type === "session.compaction.failed", event.data)
  }

  private finishModel(step: ModelState, ended: number, failed: boolean, data: { error?: { type: string }; tokens?: ModelEvent["data"]["tokens"]; cost?: number }): void {
    step.span?.setAttribute("gen_ai.provider.name", step.provider)
    const dimensions = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": step.provider }
    const attrs = { ...dimensions, "error.type": failed ? safeErrorType(data.error?.type) : undefined }
    step.span?.setAttribute("opencode.gen_ai.retry.count", step.retries)
    if (failed) {
      step.span?.setAttribute("error.type", attrs["error.type"]!)
      step.span?.setStatus({ code: SpanStatusCode.ERROR })
    } else step.span?.setStatus({ code: SpanStatusCode.OK })
    const tokens = data.tokens
    if (tokens && [tokens.input, tokens.output, tokens.cache?.read, tokens.cache?.write].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
      const input = tokens.input + tokens.cache.read + tokens.cache.write
      step.span?.setAttribute("gen_ai.usage.input_tokens", input)
      step.span?.setAttribute("gen_ai.usage.output_tokens", tokens.output)
      this.tokenUsage?.record(input, { ...dimensions, "gen_ai.token.type": "input" })
      this.tokenUsage?.record(tokens.output, { ...dimensions, "gen_ai.token.type": "output" })
    }
    this.modelDuration?.record(Math.max(0, (ended - step.started) / 1000), attrs)
    if (step.firstChunk !== undefined) this.firstChunk?.record(Math.max(0, (step.firstChunk - step.started) / 1000), dimensions)
    if (data.cost !== undefined && Number.isFinite(data.cost) && data.cost >= 0) this.cost?.add(data.cost, dimensions)
    if (step.retries) this.retryCount?.add(step.retries, dimensions)
    step.span?.end(ended)
  }

  private bufferTerminal(key: string, event: ExecutionEvent | ModelEvent | CompactionEvent): void {
    // Buffer only fields needed for correlation and telemetry; terminal payloads may carry content.
    let safe: ExecutionEvent | ModelEvent | CompactionEvent
    if (event.type.startsWith("session.execution.")) {
      const source = event as ExecutionEvent
      safe = { id: source.id, created: source.created, type: source.type, data: { sessionID: source.data.sessionID, error: source.data.error ? { type: safeErrorType(source.data.error.type), message: "", status: source.data.error.status } : undefined } }
    } else if (event.type.startsWith("session.step.")) {
      const source = event as ModelEvent
      safe = { id: source.id, created: source.created, type: source.type, data: { sessionID: source.data.sessionID, assistantMessageID: source.data.assistantMessageID, tokens: safeTokens(source.data.tokens), cost: source.data.cost, error: source.data.error ? { type: safeErrorType(source.data.error.type), message: "" } : undefined } }
    } else {
      const source = event as CompactionEvent
      safe = { id: source.id, created: source.created, type: source.type, data: { sessionID: source.data.sessionID, reason: source.data.reason, model: source.data.model && { id: source.data.model.id, providerID: source.data.model.providerID }, tokens: safeTokens(source.data.tokens), cost: source.data.cost, error: source.data.error ? { type: safeErrorType(source.data.error.type), message: "" } : undefined } }
    }
    const old = this.pendingTerminals.get(key)
    if (old) {
      if (event.created < old.created) this.pendingTerminals.set(key, safe)
    } else if (this.pendingTerminals.size < 4096) this.pendingTerminals.set(key, safe)
  }

  private takeTerminal<T extends ExecutionEvent | ModelEvent | CompactionEvent>(key: string, started: number): T | undefined {
    const event = this.pendingTerminals.get(key)
    this.pendingTerminals.delete(key)
    return event && event.created >= started ? event as T : undefined
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
      for (const model of execution.models.values()) model.span?.end()
      execution.span?.setAttribute("opencode.execution.outcome", "abandoned")
      execution.span?.end()
    }
    for (const compaction of this.compactions.values()) compaction.model.span?.end()
    this.compactions.clear()
    this.compactionSeen.clear()
    this.parents.clear()
    this.pendingTerminals.clear()
    this.active.clear()
    this.seen.clear()
  }
}

function providerName(id: string): string {
  const known: Record<string, string> = { "google-vertex": "gcp.vertex_ai", google: "gcp.gemini", "amazon-bedrock": "aws.bedrock", azure: "azure.ai.openai", mistral: "mistral_ai" }
  return Object.hasOwn(known, id) ? known[id] : id
}

function safePermissionAction(action?: string): string {
  return action && new Set(["read", "edit", "shell", "webfetch", "task", "skill", "external_directory"]).has(action) ? action : "other"
}

function safeTokens(tokens?: ModelEvent["data"]["tokens"]): ModelEvent["data"]["tokens"] {
  return tokens?.cache ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.cache.read, write: tokens.cache.write } } : undefined
}

function safeErrorType(type?: string): string {
  // Arbitrary provider error types may themselves contain content or high-cardinality identifiers.
  return type && new Set(["provider.timeout", "provider.rate-limit", "provider.invalid-request", "provider.auth", "context.overflow"]).has(type) ? type : "unknown"
}

export type Exporters = { traces?: SpanExporter; metrics?: PushMetricExporter }
type HttpOptions = NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]>
type GrpcOptions = NonNullable<ConstructorParameters<typeof GrpcTraceExporter>[0]>
type Factories = {
  traces: Record<"http/protobuf" | "http/json", (options: HttpOptions) => SpanExporter & { forceFlush(): Promise<void> }>
  metrics: Record<"http/protobuf" | "http/json", (options: HttpOptions) => PushMetricExporter & { selectAggregationTemporality: NonNullable<PushMetricExporter["selectAggregationTemporality"]> }>
  grpcTraces?: (options: GrpcOptions) => SpanExporter & { forceFlush(): Promise<void> }
  grpcMetrics?: (options: GrpcOptions) => PushMetricExporter & { selectAggregationTemporality: NonNullable<PushMetricExporter["selectAggregationTemporality"]> }
  credentials?: {
    ssl: typeof createSslCredentials
    insecure: typeof createInsecureCredentials
    metadata: typeof createEmptyMetadata
  }
}
const httpFactories: Factories = {
  traces: { "http/protobuf": (options) => new OTLPTraceExporter(options), "http/json": (options) => new JsonTraceExporter(options) },
  metrics: { "http/protobuf": (options) => new OTLPMetricExporter(options), "http/json": (options) => new JsonMetricExporter(options) },
  grpcTraces: (options) => new GrpcTraceExporter(options),
  grpcMetrics: (options) => new GrpcMetricExporter(options),
  credentials: { ssl: createSslCredentials, insecure: createInsecureCredentials, metadata: createEmptyMetadata },
}
const setupFailures = new Map<string, number>()
export function makeExporters(config: Config, factories: Factories = httpFactories): Exporters {
  const result: Exporters = {}
  let lastFailure = 0
  const diagnostic = () => {
    if (Date.now() - lastFailure < 60_000) return
    lastFailure = Date.now()
    console.info("[opencode-otel] OTLP export failed; telemetry may be dropped")
  }
  const options = (signal: SignalConfig): HttpOptions => ({
    url: signal.endpoint,
    headers: exporterSecrets(signal).headers,
    timeoutMillis: signal.timeoutMillis,
    compression: signal.compression === "gzip" ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE,
    httpAgentOptions: { keepAlive: true, ca: exporterSecrets(signal).certificate, cert: exporterSecrets(signal).clientCertificate, key: exporterSecrets(signal).clientKey },
  })
  const grpcOptions = (signal: SignalConfig): GrpcOptions => {
    const privateOptions = exporterSecrets(signal)
    const credentials = factories.credentials ?? httpFactories.credentials!
    const metadata = credentials.metadata()
    for (const [key, value] of Object.entries(privateOptions.headers)) metadata.set(key, value)
    const insecure = signal.endpoint.startsWith("http://")
    return {
      url: signal.endpoint,
      metadata,
      credentials: insecure ? credentials.insecure() : credentials.ssl(
        privateOptions.certificate ? Buffer.from(privateOptions.certificate) : undefined,
        privateOptions.clientKey ? Buffer.from(privateOptions.clientKey) : undefined,
        privateOptions.clientCertificate ? Buffer.from(privateOptions.clientCertificate) : undefined,
      ),
      timeoutMillis: signal.timeoutMillis,
      compression: signal.compression === "gzip" ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE,
    }
  }
  const setup = <T>(signal: "traces" | "metrics", protocol: string, construct: () => T): T | undefined => {
    try { return construct() } catch {
      const key = `${signal}:${protocol}`
      const now = Date.now()
      if (now - (setupFailures.get(key) ?? 0) > 60_000) {
        setupFailures.set(key, now)
        console.info(`[opencode-otel] ${signal} ${protocol === "grpc" ? "experimental gRPC" : "HTTP"} exporter initialization failed; signal disabled`)
      }
      return undefined
    }
  }
  const traceConfig = config.traces
  if (traceConfig) {
    const exporter = setup("traces", traceConfig.protocol, () => traceConfig.protocol === "grpc" ? factories.grpcTraces?.(grpcOptions(traceConfig)) : factories.traces[traceConfig.protocol]!(options(traceConfig)))
    if (exporter) {
      result.traces = {
        export(spans, callback) {
          try { exporter.export(spans, (result) => { if (result.code !== 0) diagnostic(); callback(result) }) }
          catch { diagnostic(); callback({ code: 1 }) }
        },
        shutdown: () => exporter.shutdown(),
        forceFlush: () => exporter.forceFlush(),
      }
    }
  }
  const metricConfig = config.metrics
  if (metricConfig) {
    const exporter = setup("metrics", metricConfig.protocol, () => metricConfig.protocol === "grpc" ? factories.grpcMetrics?.(grpcOptions(metricConfig)) : factories.metrics[metricConfig.protocol]!(options(metricConfig)))
    if (exporter) {
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
  }
  return result
}

const instanceID = randomUUID()
export function createTelemetry(config: Config, version: string, exporters: Exporters = makeExporters(config), shutdownTimeoutMillis = 5000, now: () => number = Date.now) {
  const resource = resourceFromAttributes({ "service.name": "opencode", "service.version": version, "service.instance.id": instanceID })
  const traces = exporters.traces ? new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(exporters.traces, { maxQueueSize: config.traces?.batchQueueSize ?? 2048, maxExportBatchSize: config.traces?.batchMaxSize ?? 512, scheduledDelayMillis: config.traces?.batchDelayMillis ?? 5000, exportTimeoutMillis: config.traces?.batchTimeoutMillis ?? 30000 })] }) : undefined
  const metrics = exporters.metrics ? new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: exporters.metrics, exportIntervalMillis: config.metrics?.exportIntervalMillis ?? 60000, exportTimeoutMillis: config.metrics?.metricTimeoutMillis ?? 30000 })] }) : undefined
  const execution = new ExecutionTelemetry(traces?.getTracer("opencode-otel"), metrics?.getMeter("opencode-otel"), now, config.providerNames, config.executionExpiryMillis)
  const cleanup = setInterval(() => { try { execution.expire() } catch { /* fail open */ } }, Math.min(config.executionExpiryMillis, 60_000))
  cleanup.unref?.()
  return {
    execution,
    traces,
    metrics,
    async shutdown() {
      clearInterval(cleanup)
      execution.end()
      // SDK shutdown can wait on network I/O. Bound plugin unload independently.
      const work = Promise.allSettled([traces?.shutdown(), metrics?.shutdown()])
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, shutdownTimeoutMillis); timer.unref?.() })])
      if (timer) clearTimeout(timer)
    },
  }
}
