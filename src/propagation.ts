import { isSpanContextValid, ROOT_CONTEXT, type SpanContext, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"

const w3c = new W3CTraceContextPropagator()

// Preserve any caller-supplied W3C context, including an incomplete pair.
export function injectTraceHeaders(headers: Headers | Record<string, string>, context: SpanContext): boolean {
  if (!isSpanContextValid(context)) return false
  if (headers instanceof Headers) {
    if (headers.has("traceparent") || headers.has("tracestate")) return false
  } else if (Object.keys(headers).some((key) => key.toLowerCase() === "traceparent" || key.toLowerCase() === "tracestate")) return false
  const values: Record<string, string> = {}
  w3c.inject(trace.setSpanContext(ROOT_CONTEXT, context), values, {
    set: (carrier, key, value) => {
      carrier[key] = value
    }
  })
  if (!values.traceparent) return false
  if (headers instanceof Headers) {
    if (values.tracestate) headers.set("tracestate", values.tracestate)
    try {
      headers.set("traceparent", values.traceparent)
    } catch (error) {
      if (values.tracestate) headers.delete("tracestate")
      throw error
    }
  } else {
    if (values.tracestate) headers.tracestate = values.tracestate
    try {
      headers.traceparent = values.traceparent
    } catch (error) {
      if (values.tracestate) delete headers.tracestate
      throw error
    }
  }
  return true
}
