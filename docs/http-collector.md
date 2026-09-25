# HTTP OTLP collector configuration

Generic endpoint `https://collector.example:4318` sends both signals to `/v1/traces` and `/v1/metrics`. Signal-specific endpoints are used as supplied. Choose `http/protobuf` (default) or `http/json` per signal; the HTTP receiver accepts both on the same port. There is no transport fallback.

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

## Client settings

- Endpoint: `"https://collector.example:4318"`.
- Custom CA: `certificate: "{env:OTEL_CA_PEM}"`. For mTLS add `clientCertificate: "{env:OTEL_CLIENT_CERT_PEM}"` and `clientKey: "{env:OTEL_CLIENT_KEY_PEM}"`. Plugin environment references hold PEM **contents**; standard `OTEL_EXPORTER_OTLP_*CERTIFICATE` / `*_KEY` variables hold PEM **file paths**.
- Collector/proxy authorization: `headers: { "Authorization": "{env:OTEL_AUTH_HEADER}" }` or `OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer%20TOKEN'`. Specific header variables override generic variables; plugin options override both, case-insensitively. The sample receiver does **not** authenticate headers.
- Bad certificate files disable the affected signal. TLS settings on plain HTTP endpoints are rejected.

For batching, metrics intervals, `timeoutMillis`, and compression, see the [operator reference](operator-reference.md). Unit tests validate settings and constructors, **not** delivery, TLS handshakes, or Collector interoperability under Bun.
