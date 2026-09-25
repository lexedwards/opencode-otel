# HTTP OTLP collector configuration

Use a generic endpoint such as `https://collector.example:4318` to send both signals to `/v1/traces` and `/v1/metrics`. A signal-specific endpoint is used exactly as supplied. Choose `http/protobuf` (default) or `http/json` independently per signal. No transport fallback occurs. The Collector HTTP receiver accepts both encodings on the same port.

```yaml
# Collector configuration: add your own processors and destination exporters.
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch: {}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

For TLS or mTLS, add to the receiver's `http` stanza:

```yaml
        tls:
          cert_file: /etc/otel/collector.crt
          key_file: /etc/otel/collector.key
          client_ca_file: /etc/otel/client-ca.crt  # omit for TLS without client authentication
```

Configure the plugin with `endpoint: "https://collector.example:4318"`. Set `certificate: "{env:OTEL_CA_PEM}"` for a custom CA; for mTLS also set `clientCertificate: "{env:OTEL_CLIENT_CERT_PEM}"` and `clientKey: "{env:OTEL_CLIENT_KEY_PEM}"`. These environment variables must contain PEM contents. Alternatively set `OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, and `OTEL_EXPORTER_OTLP_CLIENT_KEY` to readable PEM **file paths**. Malformed or missing files disable the affected signal. Certificates on plain HTTP endpoints are rejected.

To send an authorization header to a collector or authenticating reverse proxy, set `headers: { "Authorization": "{env:OTEL_AUTH_HEADER}" }` in plugin options, or `OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer%20TOKEN'` in the environment. Signal-specific header variables override generic ones; option headers override both, case-insensitively. Configure authentication at your receiver or proxy separately; the minimal Collector example above does not check the header.

Trace batching options `batchQueueSize`, `batchMaxSize`, `batchDelayMillis`, and `batchTimeoutMillis` correspond to `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, and `OTEL_BSP_EXPORT_TIMEOUT`. Metrics options `exportIntervalMillis` and `metricTimeoutMillis` correspond to `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_METRIC_EXPORT_TIMEOUT`. Plugin options override their environment settings. All intervals and timeouts are positive integer milliseconds; batch size may not exceed queue size. `timeoutMillis` and `compression` configure each signal's OTLP exporter. Unit tests validate construction and settings, not delivery, TLS handshakes, or Collector interoperability under Bun.
