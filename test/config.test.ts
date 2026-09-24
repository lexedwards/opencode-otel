import { expect, test } from "bun:test"
import { resolveConfig, establishConfig, createRegistry } from "../src/config"

test("no endpoint means neither signal is enabled", () => {
  const config = resolveConfig({}, {})
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeUndefined()
  expect(config.diagnostics).toEqual(["No OTLP endpoint configured; telemetry is inactive"])
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
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
    },
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
  const config = resolveConfig({ traces: { clientKey: "{env:KEY}" } }, {
    KEY: "hidden",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
  })
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeDefined()
  expect(config.diagnostics.join(" ")).not.toContain("hidden")
})

test("invalid trace settings disable only traces and diagnostics contain no secret", () => {
  const config = resolveConfig(
    { traces: { headers: { Authorization: "{env:MISSING_SECRET}" } } },
    { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:secret@collector.test" },
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
