# Contributing

Contributions that improve data quality, provider resilience, agent usability, or documentation are welcome.

## Development setup

```bash
pnpm install
pnpm check
pnpm build
```

`pnpm check` is deterministic and does not call live providers. Run live smoke tests locally and separately:

```bash
pnpm test:live
```

Live tests may require API keys and may be unavailable because of provider rate limits or regional restrictions. Never commit credentials or recorded responses containing credentials.

When a checkout is shared between operating systems, keep `node_modules` and `dist` out of the sync set and recreate them on each machine. Installed dependencies can contain OS-specific links and native binaries even though both directories are ignored by Git.

## Adding or changing a provider

A provider change should:

1. Normalize its output to the public types in `src/types.ts`.
2. Declare only capabilities that its free tier actually supports.
3. Enforce a documented rate limit and return actionable errors.
4. Preserve the provider name in returned data and `ProviderResult.source`.
5. Add deterministic unit tests for parsing, limits, and failure handling.
6. Add or update a small live smoke test in `tests/providers.live.test.ts`.
7. Update `docs/PROVIDERS.md`, the agent tool docs when relevant, and the provider-health probe if a new provider is introduced.

Avoid broad scraping, hidden browser automation, or providers whose terms do not permit the intended access pattern.

## Agent-facing changes

The MCP, WebMCP, TypeScript, and skill surfaces share one catalog in `src/agent/catalog.ts`. Agent tools must remain read-only, narrowly scoped, schema validated, bounded, and explicit about provenance. Do not add arbitrary command, URL-fetch, code-execution, or trading tools.

For protocol changes, update the offline MCP tests and verify the built server with the MCP Inspector.

## Pull requests

Keep each pull request focused. Explain the user impact, data-source behavior, fallback implications, and validation performed. A provider change should name the free-tier constraints it was tested against.
