# Experimental gRPC export under Bun

Set `protocol: "grpc"` explicitly for traces, metrics, or both. An endpoint such as `https://collector.example:4317` (or `collector.example:4317`, which defaults to TLS) names the host and port without a path. `http://collector.example:4317` uses insecure transport and rejects CA or client certificate configuration. A signal-specific endpoint is used as-is. There is no HTTP fallback if gRPC setup fails. Headers use the same `headers: { "Authorization": "{env:OTEL_AUTH_HEADER}" }` or standard OTLP header environment settings as HTTP and are converted to gRPC metadata. CA, client certificate, and key options use PEM-content environment references; standard OTLP certificate environment variables contain PEM **file paths**.

Add the gRPC receiver to a Collector configuration's `otlp` receiver (the `service.pipelines` references are the same as in the [HTTP example](http-collector.md)):

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        tls:
          cert_file: /etc/otel/collector.crt
          key_file: /etc/otel/collector.key
          client_ca_file: /etc/otel/client-ca.crt  # omit for TLS without client authentication
```

The official JavaScript gRPC exporter targets Node.js; Bun compatibility is **experimental**. Bun unit tests cover construction, configuration, failure isolation, and credential/metadata conversion. No live network delivery, Collector handshake, or launched-OpenCode behavior has been verified.
