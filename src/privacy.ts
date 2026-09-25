export type CaptureCategory = "inputMessages" | "outputMessages" | "systemInstructions" | "toolDefinitions"
export type CaptureOptions = Record<CaptureCategory, boolean> & { redactKeys: string[]; redactPatterns: string[] }
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; parts: Record<string, unknown>[] }
export type Bounded = { json: string; omittedMessages: number; omittedBytes: number }

const encoder = new TextEncoder()
const credential = /^(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|cookie|set-cookie)$/i
const MAX_TEXT = 4096
const MAX_ATTRIBUTE = 32768

export class PrivacyPipeline {
  private readonly keys: Set<string>
  private readonly patterns: RegExp[]
  constructor(readonly options: CaptureOptions) {
    this.keys = new Set(options.redactKeys.map((key) => key.toLowerCase()))
    this.patterns = options.redactPatterns.map((pattern) => new RegExp(pattern, "gu"))
  }

  text(value: string): string {
    const redacted = this.patterns.reduce((current, pattern) => current.replace(pattern, "[redacted]"), value)
    if (encoder.encode(redacted).length <= MAX_TEXT) return redacted
    const suffix = "[truncated]"
    let size = encoder.encode(suffix).length
    let result = ""
    for (const char of redacted) {
      const bytes = encoder.encode(char).length
      if (size + bytes > MAX_TEXT) break
      result += char
      size += bytes
    }
    return result + suffix
  }

  value(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (typeof input === "string") return input.startsWith("data:") ? "[binary omitted]" : this.text(input)
    if (typeof input === "number" || typeof input === "boolean" || input === null) return input
    if (!input || typeof input !== "object" || depth >= 12 || seen.has(input)) return "[omitted]"
    if (input instanceof Uint8Array || input instanceof ArrayBuffer || input instanceof Blob) return "[binary omitted]"
    if (!Array.isArray(input) && ["bytes", "base64", "blob"].includes(String((input as Record<string, unknown>).type))) return "[binary omitted]"
    seen.add(input)
    const result = Array.isArray(input)
      ? input.slice(0, 256).map((item) => this.value(item, depth + 1, seen))
      : Object.fromEntries(Object.entries(input).slice(0, 256).map(([key, value]) => [key, credential.test(key) || this.keys.has(key.toLowerCase()) ? "[redacted]" : /^(?:data|bytes|base64|blob)$/i.test(key) ? "[binary omitted]" : this.value(value, depth + 1, seen)]))
    seen.delete(input)
    return result
  }

  private part(part: unknown): Record<string, unknown> | undefined {
    if (!part || typeof part !== "object") return undefined
    const source = part as Record<string, unknown>
    if (source.type === "text" && typeof source.text === "string") return { type: "text", content: this.text(source.text) }
    if (source.type === "media" && source.media && typeof source.media === "object") {
      const media = source.media as Record<string, unknown>
      const ref = media.source && typeof media.source === "object" ? media.source as Record<string, unknown> : media
      const mime = typeof ref.mediaType === "string" ? this.text(ref.mediaType) : undefined
      const modality = mime?.startsWith("image/") ? "image" : mime?.startsWith("audio/") ? "audio" : mime?.startsWith("video/") ? "video" : "document"
      if (ref.type === "url" && typeof ref.url === "string" && !ref.url.startsWith("data:")) {
        try {
          const url = new URL(ref.url)
          url.username = ""; url.password = ""; url.search = ""; url.hash = ""
          return { type: "uri", modality, mime_type: mime, uri: this.text(url.toString()) }
        } catch { return undefined }
      }
      if (ref.type === "ref" && typeof ref.id === "string") return { type: "file", modality, mime_type: mime, file_id: this.text(ref.id) }
      return undefined // inline bytes, base64, and data URLs never enter telemetry
    }
    if (source.type === "tool-call" && typeof source.name === "string") return { type: "tool_call", name: this.text(source.name), ...(typeof source.id === "string" ? { id: this.text(source.id) } : {}), arguments: this.value(source.input) }
    if (source.type === "tool-result") return { type: "tool_call_response", ...(typeof source.id === "string" ? { id: this.text(source.id) } : {}), response: this.value(source.result) }
    return undefined
  }

  messages(input: unknown, role?: ChatMessage["role"]): ChatMessage[] {
    if (!Array.isArray(input)) return []
    return input.slice(-1024).flatMap((message): ChatMessage[] => {
      if (!message || typeof message !== "object") return []
      const item = message as Record<string, unknown>
      const kind = role ?? item.role
      if (kind !== "user" && kind !== "assistant" && kind !== "tool" && kind !== "system") return []
      const parts: Record<string, unknown>[] = (Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : []).slice(0, 256).flatMap((part) => { const converted = this.part(part); return converted ? [converted] : [] })
      return parts.length ? [{ role: kind, parts }] : []
    })
  }

  instructions(input: unknown): Record<string, unknown>[] {
    return (Array.isArray(input) ? input : []).slice(0, 256).flatMap((part) => { const converted = this.part(part); return converted ? [converted] : [] })
  }

  definitions(input: unknown): unknown[] {
    if (!input || typeof input !== "object" || Array.isArray(input)) return []
    return Object.entries(input).slice(0, 256).map(([name, value]) => {
      const definition = value && typeof value === "object" ? value as Record<string, unknown> : {}
      return { type: "function", name: this.text(name), ...(typeof definition.description === "string" ? { description: this.text(definition.description) } : {}), parameters: this.value(definition.input) }
    })
  }

  bound(items: unknown[], removeOldest = false): Bounded {
    const remaining = [...items]
    let json = JSON.stringify(remaining)
    let omittedMessages = 0
    let omittedBytes = 0
    while (encoder.encode(json).length > MAX_ATTRIBUTE && remaining.length) {
      const removed = removeOldest ? remaining.shift() : remaining.pop()
      omittedMessages++
      omittedBytes += encoder.encode(JSON.stringify(removed)).length
      json = JSON.stringify(remaining)
    }
    return { json, omittedMessages, omittedBytes }
  }
}
