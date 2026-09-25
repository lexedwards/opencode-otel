# v1 release readiness

Unofficial community plugin. Package **0.1.1** targets OpenCode **2.0.16** (baseline **>=2.0.11**). Later v2 compatibility is best-effort; upstream does not promise SemVer compatibility for plugin APIs.

## Reproducible checks

From a clean checkout with Bun 1.4.0:

```sh
bun install --frozen-lockfile
bun run verify
```

`verify` runs Biome formatting/lint, **TypeScript 7.0.2**, a Bun-target build, unit tests (including pinned-schema checks), and `bun pm pack --dry-run`. `tsconfig.json` explicitly lists `"types": ["bun"]`, as [Bun requires for TypeScript 6+](https://bun.com/docs/typescript-6). The Git package exports `./src/index.ts` with `src/` and pinned runtime dependencies; generated `dist/` is only a build-check artifact. The Bun build check uses `check:bundle`, not npm's `build` lifecycle trigger, so OpenCode can install the Git package without preparing it.

**Verification limit:** mocked/in-memory exporters only. No launched OpenCode, SDK service, Collector, live provider, TLS handshake, or network integration test substantiates interoperability. gRPC under Bun is experimental; see [compatibility evidence](otlp-compatibility.md).

## Release process

1. Confirm the [telemetry inventory](telemetry-inventory.md), [operator reference](operator-reference.md), [privacy controls](content-capture.md), [architecture](architecture.md), and accepted ADRs describe the shipped behavior.
2. Confirm the pinned semantic-conventions **v1.40.0** commit `7fe537301d17919af7d7eb65b32e9be35da2c497`, targeted OpenCode **2.0.16**, package version **0.1.0**, and the verified Git commit in the release notes.
3. Update [CHANGELOG.md](../CHANGELOG.md) with the release date and any verified compatibility changes. Tag the verified commit with an **immutable SemVer tag** and publish its GitHub release.
4. Point the README installation example to the newest stable tag and link its release notes. `#main` remains a development channel; an unqualified Git reference follows the default branch. Do not advertise a mutable `latest` Git ref.
