# Content capture

**Default:** metadata only. No prompts, responses, tool payloads, raw errors, stacks, or inline binary. Opted-in content stays on the relevant operation span, never in metric dimensions.

## Select categories

| Plugin option under `capture` | Destination | Enabled by `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`? |
| --- | --- | --- |
| `inputMessages`, `outputMessages` | Model CLIENT span, pinned GenAI JSON attributes | Yes, unless explicitly overridden |
| `systemInstructions`, `toolDefinitions` | Model CLIENT span, pinned GenAI JSON attributes | Yes, unless explicitly overridden |
| `toolArguments`, `toolResults` | Matching `execute_tool` span, JSON attributes | No |
| `errorMessages`, `stackTraces` | Failing agent/model/tool span (`exception.message`, `exception.stacktrace`) | No |

Example: `"capture": { "inputMessages": true, "toolArguments": true, "stackTraces": false }`. Each switch is independent. Invalid capture settings disable capture with a content-free diagnostic. Error type/status remain available without error-content opt-in.

## Bound and redact

1. Built-in credential-like property names (`authorization`, `password`, `secret`, `token`, `apiKey`, `accessKey`, `privateKey`, `clientSecret`, `credential`, cookies) are redacted, including nested objects and assignment-like text.
2. Add case-insensitive property names in `capture.redactKeys` and text regexes in `capture.redactPatterns`. These rules cannot find every secret; configure them for your data.
3. Redaction runs **before** measuring. Each text part is at most **4 KiB UTF-8**, with `[truncated]` when shortened; each serialized attribute is at most **32 KiB**.
4. Oversized input drops oldest complete messages first and records `opencode.gen_ai.input.messages.omitted_messages` and `.omitted_bytes`. Other lists trim from the end; oversized tool JSON drops trailing entries while remaining valid JSON. Unsupported or cyclic values use placeholders.

Inline image, audio, video, file bytes, base64 and data URLs are omitted. External URI/file references may include modality and MIME type; redact IDs/URIs if they contain secrets. Pinned v1.40.0 input, output, and instruction JSON schemas are checked in unit tests.

## Source limitations

- Primary input: OpenCode context hook. Assistant output: completed text events for the active model. Missing or unmatched events are omitted.
- Compaction: only the **completed summary** may be captured as output; no partial input transcript or text deltas.
- Title and transient generate requests have no model spans or captured content.
