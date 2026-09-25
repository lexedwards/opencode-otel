import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base"
import { createEmptyMetadata, createInsecureCredentials } from "@opentelemetry/otlp-grpc-exporter-base"
import { AggregationTemporality } from "@opentelemetry/sdk-metrics"
import { resolveConfig } from "../src/config"
import { createTelemetry, makeExporters } from "../src/telemetry"

test("explicit HTTP encodings receive isolated headers, TLS material and options without network access", async () => {
  const dir = mkdtempSync("/tmp/opencode/otel-")
  try {
    const ca = `${dir}/ca.pem`
    const cert = `${dir}/client.pem`
    const key = `${dir}/key.pem`
    const root = "-----BEGIN CERTIFICATE-----\nroot-private\n-----END CERTIFICATE-----"
    const client = "-----BEGIN CERTIFICATE-----\nclient-private\n-----END CERTIFICATE-----"
    const privateKey = "-----BEGIN PRIVATE KEY-----\nkey-private\n-----END PRIVATE KEY-----"
    writeFileSync(ca, root)
    writeFileSync(cert, client)
    writeFileSync(key, privateKey)
    const env = {
      TOKEN: "Bearer private",
      OTEL_EXPORTER_OTLP_HEADERS: "x-org=shared,Authorization=Bearer%20environment",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-org=metrics",
      OTEL_EXPORTER_OTLP_CERTIFICATE: ca,
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: cert,
      OTEL_EXPORTER_OTLP_CLIENT_KEY: key
    }
    const config = resolveConfig(
      {
        endpoint: "https://collector.test/otlp",
        traces: { protocol: "http/json", headers: { Authorization: "{env:TOKEN}" }, timeoutMillis: 4000, compression: "gzip" },
        metrics: { protocol: "http/protobuf" }
      },
      env
    )
    env.TOKEN = "Bearer changed"
    writeFileSync(key, "changed on disk")
    const captured: { protocol: string; signal: string; options: unknown }[] = []
    const factories: NonNullable<Parameters<typeof makeExporters>[1]> = {
      traces: {
        "http/json": (options) => {
          captured.push({ protocol: "http/json", signal: "traces", options })
          return {
            export(_spans, done) {
              done({ code: 0 })
            },
            shutdown: async () => {},
            forceFlush: async () => {}
          }
        },
        "http/protobuf": () => {
          throw Error("wrong traces protocol")
        }
      },
      metrics: {
        "http/protobuf": (options) => {
          captured.push({ protocol: "http/protobuf", signal: "metrics", options })
          return {
            export(_data, done) {
              done({ code: 0 })
            },
            shutdown: async () => {},
            forceFlush: async () => {},
            selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE
          }
        },
        "http/json": () => {
          throw Error("wrong metrics protocol")
        }
      }
    }
    const exporters = makeExporters(config, factories)
    expect(exporters.traces).toBeDefined()
    expect(exporters.metrics).toBeDefined()
    expect(captured).toMatchObject([
      {
        signal: "traces",
        protocol: "http/json",
        options: {
          url: "https://collector.test/otlp/v1/traces",
          headers: { authorization: "Bearer private", "x-org": "shared" },
          timeoutMillis: 4000,
          compression: CompressionAlgorithm.GZIP,
          httpAgentOptions: { ca: root, cert: client, key: privateKey }
        }
      },
      {
        signal: "metrics",
        protocol: "http/protobuf",
        options: {
          url: "https://collector.test/otlp/v1/metrics",
          headers: { authorization: "Bearer environment", "x-org": "metrics" },
          httpAgentOptions: { ca: root, cert: client, key: privateKey }
        }
      }
    ])
    expect(JSON.stringify(config)).not.toMatch(/private|Bearer environment|root-private|key-private|\/tmp\/opencode/)
    await exporters.traces?.shutdown()
    await exporters.metrics?.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bad certificate files disable only their signal without printing paths", () => {
  const config = resolveConfig({ endpoint: "https://collector.test", traces: { certificate: "{env:BAD_PEM}" } }, { BAD_PEM: "private malformed PEM" })
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeDefined()
  expect(config.diagnostics.join(" ")).not.toContain("private")
  const file = resolveConfig({ endpoint: "https://collector.test" }, { OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: "/private/nonexistent/ca.pem" })
  expect(file.traces).toBeUndefined()
  expect(file.metrics).toBeDefined()
  expect(file.diagnostics.join(" ")).not.toContain("/private")
  const plain = resolveConfig(
    { endpoint: "http://collector.test", certificate: "{env:CA}" },
    { CA: "-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----" }
  )
  expect(plain.traces).toBeUndefined()
  expect(plain.metrics).toBeUndefined()
  const header = resolveConfig({ endpoint: "https://collector.test" }, { OTEL_EXPORTER_OTLP_TRACES_HEADERS: "bad header=private" })
  expect(header.traces).toBeUndefined()
  expect(header.metrics).toBeDefined()
  expect(header.diagnostics.join(" ")).not.toContain("private")
})

test("trace batching honors configured maximum export batch size", async () => {
  const config = resolveConfig({ traces: { endpoint: "https://collector.test/v1/traces", batchQueueSize: 4, batchMaxSize: 1 } }, {})
  const sizes: number[] = []
  const pipeline = createTelemetry(config, "2.0.16", {
    traces: {
      export(spans, done) {
        sizes.push(spans.length)
        done({ code: 0 })
      },
      shutdown: async () => {}
    }
  })
  for (const [index, sessionID] of ["session-a", "session-b"].entries()) {
    pipeline.execution.onEvent({ type: "session.execution.started", id: `start-${index}`, created: 1000, data: { sessionID } }, "project")
    pipeline.execution.onEvent({ type: "session.execution.succeeded", id: `end-${index}`, created: 2000, data: { sessionID } }, "project")
  }
  await pipeline.traces?.forceFlush()
  expect(sizes).toEqual([1, 1])
  await pipeline.shutdown()
})

test("gRPC is explicit, isolated per signal, and passes private metadata and TLS credentials", async () => {
  const config = resolveConfig(
    { endpoint: "https://collector.test:4317", protocol: "grpc", headers: { Authorization: "{env:TOKEN}" }, certificate: "{env:CA}" },
    {
      TOKEN: "Bearer private",
      CA: "-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----"
    }
  )
  const seen: { signal: string; options: unknown }[] = []
  const certs: unknown[] = []
  const diagnostic = spyOn(console, "info").mockImplementation(() => {})
  const factories: NonNullable<Parameters<typeof makeExporters>[1]> = {
    traces: {
      "http/json": () => {
        throw Error("HTTP fallback")
      },
      "http/protobuf": () => {
        throw Error("HTTP fallback")
      }
    },
    metrics: {
      "http/json": () => {
        throw Error("HTTP fallback")
      },
      "http/protobuf": () => {
        throw Error("HTTP fallback")
      }
    },
    grpcTraces: (options) => {
      seen.push({ signal: "traces", options })
      throw Error("Bun gRPC unsupported")
    },
    grpcMetrics: (options) => {
      seen.push({ signal: "metrics", options })
      return {
        export(_data, done) {
          done({ code: 0 })
        },
        shutdown: async () => {},
        forceFlush: async () => {},
        selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE
      }
    },
    credentials: {
      ssl: (...args) => {
        certs.push(args.map((value) => value?.toString()))
        return createInsecureCredentials()
      },
      insecure: createInsecureCredentials,
      metadata: createEmptyMetadata
    }
  }
  const exporters = makeExporters(config, factories)
  expect(diagnostic.mock.calls.map((call) => call[0])).toEqual(["[opencode-otel] traces experimental gRPC exporter initialization failed; signal disabled"])
  diagnostic.mockRestore()
  expect(exporters.traces).toBeUndefined()
  expect(exporters.metrics).toBeDefined()
  expect(seen).toHaveLength(2)
  expect(certs).toHaveLength(2)
  expect(certs[0]).toEqual(["-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----", undefined, undefined])
  expect((seen[1]?.options as { metadata: ReturnType<typeof createEmptyMetadata> }).metadata.get("authorization")).toEqual(["Bearer private"])
  expect(JSON.stringify(config)).not.toContain("Bearer private")
  await exporters.metrics?.shutdown()
})

test("gRPC rejects TLS settings on cleartext endpoints without enabling a sibling signal", () => {
  const config = resolveConfig(
    { traces: { endpoint: "http://collector.test:4317", protocol: "grpc", certificate: "{env:CA}" } },
    { CA: "-----BEGIN CERTIFICATE-----\nprivate\n-----END CERTIFICATE-----" }
  )
  expect(config.traces).toBeUndefined()
  expect(config.metrics).toBeUndefined()
  expect(config.diagnostics.join(" ")).not.toContain("private")
  const plain = resolveConfig({ metrics: { endpoint: "http://collector.test:4317", protocol: "grpc" } }, {})
  const exporters = makeExporters(plain)
  expect(exporters.traces).toBeUndefined()
  expect(exporters.metrics).toBeDefined()
  return exporters.metrics?.shutdown()
})

test("official gRPC exporters construct for both signals without HTTP fallback or network I/O", async () => {
  const config = resolveConfig({ endpoint: "http://collector.test:4317", protocol: "grpc" }, {})
  const exporters = makeExporters(config)
  expect(exporters.traces).toBeDefined()
  expect(exporters.metrics).toBeDefined()
  await exporters.traces?.shutdown()
  await exporters.metrics?.shutdown()
})
