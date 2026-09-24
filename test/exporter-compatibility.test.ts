import { describe, expect, test } from "bun:test"
import { OTLPTraceExporter as JsonTraces } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter as JsonMetrics } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter as ProtoTraces } from "@opentelemetry/exporter-trace-otlp-proto"
import { OTLPMetricExporter as ProtoMetrics } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter as GrpcTraces } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPMetricExporter as GrpcMetrics } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base"

describe("Bun exporter construction (no export or network I/O)", () => {
  for (const [name, Trace, Metric, url] of [
    ["http/json", JsonTraces, JsonMetrics, "https://collector.example/v1"],
    ["http/protobuf", ProtoTraces, ProtoMetrics, "https://collector.example/v1"],
    ["grpc", GrpcTraces, GrpcMetrics, "https://collector.example:4317"],
  ] as const) {
    test(`${name}: trace and metric exporters`, async () => {
      const traces = new Trace({ url, timeoutMillis: 100, compression: CompressionAlgorithm.GZIP })
      const metrics = new Metric({ url, timeoutMillis: 100, compression: CompressionAlgorithm.GZIP })
      expect(typeof traces.export).toBe("function")
      expect(typeof metrics.export).toBe("function")
      await traces.shutdown()
      await metrics.shutdown()
    })
  }
})
