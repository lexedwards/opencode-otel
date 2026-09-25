# Permission telemetry

| On an active agent execution | Signal |
| --- | --- |
| `permission.asked` | `opencode.permission.asked` root-span event; `opencode.permission.request.count`. |
| Matching `permission.replied` | `opencode.permission.replied` root-span event; `opencode.permission.reply.count`; `opencode.permission.wait.duration` (seconds, nonnegative). |

These are span events, **not** OpenTelemetry logs. Replies are `once`, `always`, or `reject`. Unmatched, duplicate, and expired replies produce no reply metric. Pending requests expire after 30 minutes; execution completion discards them.

- Only bounded `opencode.permission.action` and `opencode.permission.reply` values become event attributes or metric dimensions.
- Actions: `read`, `edit`, `shell`, `webfetch`, `task`, `skill`, `external_directory`; unknown actions become `other`.
- Request IDs remain in memory for matching. Paths, commands, save patterns, request messages, and arbitrary metadata are never exported.
- Limits per execution: 2048 pending requests and 4096 recent completion IDs. Capacity/correlation failures emit rate-limited content-free diagnostics.
