# Experimental gRPC export under Bun

Set `protocol: "grpc"` per signal (or globally). There is no HTTP fallback.

| Endpoint | Transport |
| --- | --- |
| `https://collector.example:4317` or `collector.example:4317` | TLS by default; host and port only. |
| `http://collector.example:4317` | Insecure; rejects CA and client certificate settings. |

Plugin `headers: { "Authorization": "{env:OTEL_AUTH_HEADER}" }` and standard OTLP headers become gRPC metadata. Plugin CA/cert/key references contain PEM **contents**; standard OTLP certificate variables point to PEM **files**.

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

The JavaScript gRPC exporter targets Node.js; Bun compatibility is **experimental**. Unit tests cover construction, configuration, failure isolation, and credential conversion, **not** live delivery, Collector handshake, or launched OpenCode.
