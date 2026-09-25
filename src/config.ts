export type Protocol = "http/protobuf" | "http/json" | "grpc"
export type Signal = "traces" | "metrics"
export type SignalOptions = {
  endpoint?: string
  protocol?: Protocol
  headers?: Record<string, string>
  timeoutMillis?: number
  compression?: "none" | "gzip"
  certificate?: string
  clientCertificate?: string
  clientKey?: string
}
export type Options = SignalOptions & { traces?: SignalOptions; metrics?: SignalOptions; providerNames?: Record<string, string> }
export type SignalConfig = Required<Pick<SignalOptions, "endpoint" | "protocol" | "headers" | "timeoutMillis" | "compression">> &
  Pick<SignalOptions, "certificate" | "clientCertificate" | "clientKey">
export type Config = { traces?: SignalConfig; metrics?: SignalConfig; providerNames?: Record<string, string>; diagnostics: string[] }
type Environment = Record<string, string | undefined>

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("options")
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw Error(field)
  return value.trim()
}

function secret(value: unknown, field: string, env: Environment): string | undefined {
  const raw = text(value, field)
  if (raw === undefined) return undefined
  const match = /^\{env:([A-Za-z_][A-Za-z_0-9]*)\}$/.exec(raw)
  if (!match) throw Error(field + " reference")
  const resolved = env[match[1]]
  if (!resolved) throw Error(field + " reference")
  return resolved
}

function headers(value: unknown, env: Environment, fromOptions: boolean): Record<string, string> {
  if (value === undefined) return {}
  if (!fromOptions && typeof value === "string") {
    return Object.fromEntries(value.split(",").filter(Boolean).map((pair) => {
      const i = pair.indexOf("=")
      if (i < 1) throw Error("header")
      return [decodeURIComponent(pair.slice(0, i).trim()), decodeURIComponent(pair.slice(i + 1).trim())]
    }))
  }
  const obj = record(value)
  return Object.fromEntries(Object.entries(obj).map(([key, raw]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw Error("header")
    return [key, secret(raw, "header", env)!]
  }))
}

function endpoint(value: unknown, field: string, generic: boolean, signal: Signal, protocol: Protocol): string {
  const raw = text(value, field)!
  if (protocol === "grpc") {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw Error(field)
    return raw
  }
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw Error(field)
  if (generic) return raw.replace(/\/$/, "") + `/v1/${signal}`
  return raw
}

function resolveSignal(signal: Signal, options: Record<string, unknown>, env: Environment): SignalConfig | undefined {
  const scoped = record(options[signal])
  const prefix = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_`
  const generic = "OTEL_EXPORTER_OTLP_"
  const select = (key: string, option: string = key.toLowerCase()) => scoped[option] ?? options[option] ?? env[prefix + key] ?? env[generic + key]
  const rawEndpoint = scoped.endpoint ?? options.endpoint ?? env[prefix + "ENDPOINT"] ?? env[generic + "ENDPOINT"]
  const isGenericEndpoint = scoped.endpoint === undefined && (options.endpoint !== undefined || env[prefix + "ENDPOINT"] === undefined)
  const rawProtocol = select("PROTOCOL", "protocol") ?? "http/protobuf"
  if (rawProtocol !== "http/protobuf" && rawProtocol !== "http/json" && rawProtocol !== "grpc") throw Error("protocol")
  const protocol: Protocol = rawProtocol
  const selectedHeaders = scoped.headers ?? options.headers
  const mergedHeaders = { ...headers(env[generic + "HEADERS"], env, false), ...headers(env[prefix + "HEADERS"], env, false), ...headers(selectedHeaders, env, true) }
  const rawTimeout = select("TIMEOUT", "timeoutMillis") ?? 10000
  const timeoutMillis = Number(rawTimeout)
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) throw Error("timeout")
  const compression = select("COMPRESSION", "compression") ?? "none"
  if (compression !== "none" && compression !== "gzip") throw Error("compression")
  const certificate = select("CERTIFICATE", "certificate")
  const clientCertificate = select("CLIENT_CERTIFICATE", "clientCertificate")
  const clientKey = select("CLIENT_KEY", "clientKey")
  if ((clientCertificate === undefined) !== (clientKey === undefined)) throw Error("client certificate")
  const resolvedCertificate = certificate === undefined ? undefined : scoped.certificate !== undefined || options.certificate !== undefined ? secret(certificate, "certificate", env) : text(certificate, "certificate")
  const resolvedClientCertificate = clientCertificate === undefined ? undefined : scoped.clientCertificate !== undefined || options.clientCertificate !== undefined ? secret(clientCertificate, "client certificate", env) : text(clientCertificate, "client certificate")
  const resolvedClientKey = clientKey === undefined ? undefined : scoped.clientKey !== undefined || options.clientKey !== undefined ? secret(clientKey, "client key", env) : text(clientKey, "client key")
  if (rawEndpoint === undefined) return undefined
  return {
    endpoint: endpoint(rawEndpoint, "endpoint", isGenericEndpoint, signal, protocol),
    protocol,
    headers: mergedHeaders,
    timeoutMillis,
    compression,
    certificate: resolvedCertificate,
    clientCertificate: resolvedClientCertificate,
    clientKey: resolvedClientKey,
  }
}

export function resolveConfig(options: unknown, env: Environment = process.env): Config {
  const config: Config = { diagnostics: [] }
  try {
    const names = record(record(options).providerNames)
    config.providerNames = Object.fromEntries(Object.entries(names).map(([key, value]) => {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key) || typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw Error("provider names")
      return [key, value]
    }))
  } catch { config.diagnostics.push("Provider name overrides invalid; defaults used") }
  for (const signal of ["traces", "metrics"] as const) {
    try {
      config[signal] = resolveSignal(signal, record(options), env)
    } catch (error) {
      const field = error instanceof Error && /^[a-z ]+( reference)?$/.test(error.message) ? error.message : "setting"
      config.diagnostics.push(`${signal === "traces" ? "Traces" : "Metrics"} configuration invalid (${field}); signal disabled`)
    }
  }
  if (!config.traces && !config.metrics && config.diagnostics.length === 0) config.diagnostics.push("No OTLP endpoint configured; telemetry is inactive")
  return config
}

export type Registry = { current?: Config; users: number }
export function createRegistry(): Registry { return { users: 0 } }

export function establishConfig(registry: Registry, proposed: Config): { config: Config; diagnostic?: string; release: () => void } {
  const diagnostic = registry.current && JSON.stringify([registry.current.traces, registry.current.metrics, registry.current.providerNames]) !== JSON.stringify([proposed.traces, proposed.metrics, proposed.providerNames])
    ? "Effective exporter configuration conflicts with an active instance; restart the OpenCode service to apply changes"
    : undefined
  registry.current ??= proposed
  registry.users++
  let released = false
  return {
    config: registry.current,
    diagnostic,
    release() {
      if (released) return
      released = true
      if (--registry.users === 0) registry.current = undefined
    },
  }
}
