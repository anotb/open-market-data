# Testing

The suite is split in two. The default suite is **deterministic** — it mocks every
network call, so it runs offline, in CI, and on a plane, and it is never allowed to
flake. A second, opt-in suite hits the real APIs to confirm upstream contracts still
hold.

```bash
pnpm test           # deterministic suite (default) — no network
pnpm test:watch     # same, in watch mode
pnpm test:coverage  # same, with v8 coverage + thresholds
pnpm test:live      # real API smoke tests (slow, needs network)
pnpm test:all       # both
pnpm check          # lint + typecheck + deterministic tests
```

## Layout

| Path | What lives there |
| --- | --- |
| `tests/helpers/` | Shared harness: fetch mocking, module-state helpers, provider factories |
| `tests/unit/` | Pure logic — formatter, cache, rate limiter, config, router |
| `tests/providers/` | One file per provider, every HTTP call mocked |
| `tests/contract/` | Invariants every provider must satisfy, plus CLI smoke tests |
| `tests/live/` | Real network calls. Excluded from `pnpm test` on purpose |

`vitest.config.ts` drives the deterministic suite and excludes `tests/live/**`.
`vitest.live.config.ts` runs only `tests/live/**`, one file at a time with a retry,
because third-party APIs rate-limit.

## The fetch harness

`tests/helpers/mock-fetch.ts` replaces `globalThis.fetch`. Its defining property:
**a request that matches no route throws**. A test can never quietly fall through to
the real network and become flaky months later.

```ts
const fx = mockFetch([
  { match: /\/ticker\/24hr/, respond: { json: TICKER_FIXTURE } },
  { match: '/klines', respond: { status: 451, text: 'restricted' } },
])

const result = await binance.execute('crypto', 'quote', { symbol: 'BTC' })

expect(fx.callCount()).toBe(1)
expect(fx.query('/ticker').symbol).toBe('BTCUSDT')
expectNoUnmatched(fx)
```

Routes match by substring, `RegExp`, or predicate, and are tried in order. `respond`
can be a static spec or a function receiving the request context (URL, headers, body,
and how many times this route has already matched). `times` retires a route after N
hits so a later route can take over — useful for "fails once, then succeeds".

Helpers on the returned handle: `calls`, `unmatched`, `callCount(m)`, `urls(m)`,
`call(m)`, `query(m)`, `restore()`. Plus `mockFetchFailure(status, body)` and
`mockFetchNetworkError(msg)` for the common cases.

The harness has its own tests in `tests/unit/harness.test.ts`. If those fail, treat
every other provider failure as suspect.

## Modules that remember things

Several modules memoize at module scope, which makes them order-dependent across
tests:

- `core/config.ts` caches the resolved config and reads `.env` **at import time**
- `providers/sec-edgar.ts` caches the ticker map and a warn-once flag
- `providers/binance.ts` latches geo-restriction after a 451
- `core/router.ts` holds the registered-provider array

Use `freshImport()` from `tests/helpers/modules.ts` to get a clean copy:

```ts
const { binance } = await freshImport<typeof import('../../src/providers/binance.js')>(
  '../../src/providers/binance.js',
)
```

One catch worth internalising: `vi.resetModules()` resets the **whole** registry, so
a module you obtained via `freshImport` is a different instance from the one imported
at the top of your test file. If a test needs two modules to see each other's state,
obtain both from the same fresh generation.

`makeTempHome()` repoints `$HOME` at a throwaway directory so config tests read and
write `<temp>/.omd/config.json` instead of the developer's real config.
`clearConfigEnv()` wipes the provider key env vars and hands back a restore function.

## Rules for new tests

1. **No network in the default suite.** Mock it, or put the test in `tests/live/`.
2. **No wall-clock dependence.** Anything that reads "now" gets
   `vi.useFakeTimers()` + `vi.setSystemTime(...)`. Several providers compute year and
   day ranges from the current date, and a few call `toISOString()`, so an unpinned
   clock means a test that fails in a different timezone or at a year boundary.
3. **Assert behaviour, not implementation.** A test that cannot fail when the product
   regresses is worse than no test — it just costs time to maintain.
4. **Assert exact user-visible strings.** Error messages and formatter output are the
   product surface; a vague `toContain` lets real regressions through.
5. Style is enforced by Biome: tabs, single quotes, no semicolons.

## Coverage

`pnpm test:coverage` writes `coverage/` and enforces thresholds set in
`vitest.config.ts`. `src/cli.ts` and the type-only modules are excluded — the CLI is
covered end-to-end by `tests/contract/cli.test.ts`, which builds the package and runs
the real binary as a subprocess.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, build, and the deterministic suite
across Node 20, 22, and 24 on every push and PR. The live suite runs separately and is
marked `continue-on-error`: a failure there means an upstream API changed, not that
the pull request is broken.
