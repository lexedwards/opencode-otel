import { expect, test } from "bun:test"
import { createRegistry, establishConfig, resolveConfig } from "../src/config"

test("no endpoint means neither signal is enabled", () => {
  const config = resolveConfig({}, {})
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeUndefined()
  expect(config.diagnostics).toEqual(["No OTLP endpoint configured; telemetry is inactive"])
  expect(config.executionExpiryMillis).toBe(24 * 60 * 60_000)
})

test("invalid execution expiry falls back to the 24-hour default", () => {
  const config = resolveConfig({ endpoint: "https://collector.test", executionExpiryMillis: -1 }, {})
  expect(config.executionExpiryMillis).toBe(24 * 60 * 60_000)
  expect(config.diagnostics).toContain("Execution expiry invalid; using 24-hour default")
})

test("signal-specific endpoints do not activate their sibling", () => {
  const config = resolveConfig({}, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.test/custom" })
  expect(config.traces?.endpoint).toBe("https://collector.test/custom")
  expect(config.metrics).toBeUndefined()
})

test("generic endpoint appends HTTP signal path and options override signal and generic env", () => {
  const config = resolveConfig(
    { traces: { protocol: "http/json", endpoint: "https://option.test/v1/traces" } },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.test/otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://specific.test/traces",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc"
    }
  )
  expect(config.traces).toMatchObject({ endpoint: "https://option.test/v1/traces", protocol: "http/json" })
  expect(config.metrics).toMatchObject({ endpoint: "https://generic.test/otlp/v1/metrics", protocol: "http/protobuf" })
})

test("generic plugin option overrides signal-specific environment endpoint", () => {
  const config = resolveConfig({ endpoint: "https://option.test/base" }, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://env.test/custom" })
  expect(config.traces?.endpoint).toBe("https://option.test/base/v1/traces")
  expect(config.metrics?.endpoint).toBe("https://option.test/base/v1/metrics")
})

test("invalid protocol or incomplete mTLS affects only configured signal", () => {
  const config = resolveConfig(
    { traces: { clientKey: "{env:KEY}" } },
    {
      KEY: "hidden",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test"
    }
  )
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeDefined()
  expect(config.diagnostics.join(" ")).not.toContain("hidden")
})

test("invalid trace settings disable only traces and diagnostics contain no secret", () => {
  const config = resolveConfig(
    { traces: { headers: { Authorization: "{env:MISSING_SECRET}" } } },
    { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:secret@collector.test" }
  )
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeDefined()
  expect(config.diagnostics.join(" ")).not.toMatch(/secret|user|collector/i)
})

test("missing referenced secret disables affected signal", () => {
  const config = resolveConfig({ metrics: { endpoint: "https://collector.test", headers: { Authorization: "{env:TOKEN}" } } }, {})
  expect(config.metrics).toBeUndefined()
  expect(config.diagnostics).toEqual(["Metrics configuration invalid (header reference); signal disabled"])
})

test("malformed settings are diagnosed even without endpoints", () => {
  const config = resolveConfig({ traces: { protocol: "wrong" } }, {})
  expect(config.traces).toBeUndefined()
  expect(config.diagnostics).toEqual(["Traces configuration invalid (protocol); signal disabled"])
})

test("gRPC accepts host:port without appending a signal path", () => {
  const config = resolveConfig({ endpoint: "collector.test:4317", protocol: "grpc" }, {})
  expect(config.traces?.endpoint).toBe("collector.test:4317")
  expect(config.metrics?.endpoint).toBe("collector.test:4317")
})

test("process configuration is fixed across instances until final cleanup", () => {
  const registry = createRegistry()
  const first = resolveConfig({ endpoint: "https://one.test" }, {})
  const conflict = resolveConfig({ endpoint: "https://two.test" }, {})
  const a = establishConfig(registry, first)
  const b = establishConfig(registry, conflict)
  expect(b.config).toBe(a.config)
  expect(b.diagnostic).toContain("restart the OpenCode service")
  a.release()
  const c = establishConfig(registry, first)
  expect(c.config).toBe(a.config)
  b.release()
  c.release()
  expect(establishConfig(registry, conflict).config).toBe(conflict)
})

test("HTTP secret references are resolved once without appearing in printable config", () => {
  const env = {
    TOKEN: "Bearer private-token",
    CA: "-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test"
  }
  const config = resolveConfig({ traces: { headers: { Authorization: "{env:TOKEN}" }, certificate: "{env:CA}" } }, env)
  expect(config.traces).toBeDefined()
  expect(JSON.stringify(config)).not.toMatch(/private-token|private-ca|\{env:/)
  env.TOKEN = "changed"
  expect(JSON.stringify(config)).not.toContain("changed")
  expect(config.metrics).toBeDefined()
})

test("standard HTTP controls resolve per signal and reject invalid batching", () => {
  const config = resolveConfig(
    { endpoint: "https://collector.test", traces: { protocol: "http/json", batchMaxSize: 100 }, metrics: { exportIntervalMillis: 15000 } },
    {
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20secret,x-custom=one",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-custom=two",
      OTEL_BSP_MAX_QUEUE_SIZE: "200",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "150",
      OTEL_BSP_SCHEDULE_DELAY: "7000",
      OTEL_BSP_EXPORT_TIMEOUT: "25000",
      OTEL_METRIC_EXPORT_INTERVAL: "12000",
      OTEL_METRIC_EXPORT_TIMEOUT: "26000"
    }
  )
  expect(config.traces).toMatchObject({ protocol: "http/json", batchMaxSize: 100, batchQueueSize: 200, batchDelayMillis: 7000, batchTimeoutMillis: 25000 })
  expect(config.metrics).toMatchObject({ exportIntervalMillis: 15000, metricTimeoutMillis: 26000 })
  expect(JSON.stringify(config)).not.toContain("Bearer secret")
  const invalid = resolveConfig({ endpoint: "https://collector.test", traces: { batchMaxSize: 500, batchQueueSize: 100 } }, {})
  expect(invalid.traces).toBeUndefined()
  expect(invalid.metrics).toBeDefined()
})
