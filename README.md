# open-market-data

[![CI](https://github.com/anotb/open-market-data/actions/workflows/ci.yml/badge.svg)](https://github.com/anotb/open-market-data/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/open-market-data)](https://www.npmjs.com/package/open-market-data)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`open-market-data` is a read-only data layer for stocks, company fundamentals, SEC filings, crypto, and macroeconomic data. The Agent Skill, MCP server, TypeScript client, and CLI all return the same normalized results.

```text
one package -> capability routing -> free public data sources -> normalized data + provenance
```

You can use stock data, SEC filings, World Bank indicators, and CoinGecko without an API key. Optional free keys add FRED data, a dedicated CoinGecko quota, and more fallback providers.

## Why use it

- **One package, several interfaces:** use it as an Agent Plugin, MCP server, TypeScript library, CLI, or experimental WebMCP adapter
- **Read-only tools:** each tool has a narrow JSON Schema, bounded output, and no trading or arbitrary execution capability
- **Useful without keys:** stock, SEC, World Bank, and CoinGecko data work out of the box; Binance is also keyless where available
- **Provider fallback:** capability routing, caching, rate-limit awareness, and health checks help handle upstream outages
- **Consistent results:** every interface uses the same tool catalog and normalized provider layer
- **Clear provenance:** responses identify their source and say whether the result came from cache

## Install as an Agent Plugin

The repository follows the vendor-neutral **Agent Plugins 1.0.0** layout:

```text
plugin.json                     portable plugin identity
skills/open-market-data/        Agent Skills workflow
mcp.json                        portable local stdio MCP server
.codex-plugin/plugin.json       current ChatGPT/Codex compatibility
.mcp.json                       current ChatGPT/Codex bundled MCP config
```

Compatible clients can load both the skill and MCP server from the package. ChatGPT/Codex compatibility files live alongside the portable manifests for clients that still use them.

ChatGPT/Codex users can add the repository as a plugin marketplace:

```bash
codex plugin marketplace add anotb/open-market-data
```

The marketplace installs the compiled npm package. If you load a source checkout instead, run `pnpm build` first.

See [docs/AGENT-PLUGIN.md](docs/AGENT-PLUGIN.md) for package structure, validation, compatibility, and distribution details.

## Connect an AI agent

The package includes a local stdio MCP server, so there is no separate service to deploy. It supports the stateless `2026-07-28` protocol as well as session-based legacy clients. The simplest setup is:

```bash
# Claude Code
claude mcp add open-market-data -- npx -y open-market-data

# Codex
codex mcp add open-market-data -- npx -y open-market-data
```

For Cursor, Claude Desktop, and clients that use `mcpServers`:

```json
{
  "mcpServers": {
    "open-market-data": {
      "command": "npx",
      "args": ["-y", "open-market-data"]
    }
  }
}
```

For VS Code:

```json
{
  "servers": {
    "open-market-data": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "open-market-data"]
    }
  }
}
```

Agents receive seventeen purpose-built, read-only tools rather than shell access:

| Area | Tools |
|---|---|
| Discovery and diagnostics | `market_search`, `provider_status`, `provider_health` |
| Company research | `company_snapshot`, `stock_quotes`, `stock_financials`, `stock_history` |
| Events and derivatives | `stock_options`, `stock_earnings`, `stock_dividends` |
| SEC | `sec_filings`, `sec_insider_transactions` |
| Crypto | `crypto_quote`, `crypto_top`, `crypto_history` |
| Macro | `macro_series`, `macro_search` |

For company research, start with `company_snapshot`. It combines a quote, recent performance, quarterly financials, earnings, and recent SEC filings. If one provider is unavailable, the tool returns the available components and reports the missing ones explicitly.

See [docs/AGENT-PLUGIN.md](docs/AGENT-PLUGIN.md) for portable packaging and [docs/MCP.md](docs/MCP.md) for direct MCP configuration, response envelopes, WebMCP, troubleshooting, and registry publishing.

## Install the CLI

Requires a supported Node.js release: Node.js 22 or later.

```bash
npm install -g open-market-data
```

```bash
# Stocks and companies
omd quote AAPL MSFT GOOGL
omd financials AAPL -p quarterly
omd history AAPL --days 30
omd earnings AAPL
omd dividends AAPL
omd options AAPL
omd search "Apple Inc"

# SEC filings
omd filing AAPL --type 10-K --latest
omd insiders AAPL

# Crypto
omd crypto BTC
omd crypto top 10
omd crypto history BTC --days 30

# Keyless global economic data from World Bank
omd --source worldbank macro get NY.GDP.MKTP.CD --country US --limit 12
omd --source worldbank macro search "inflation"

# FRED series after configuring FRED_API_KEY
omd --source fred macro get GDP --limit 12
omd --source fred macro get UNRATE --limit 12

# Validate every provider (missing optional keys are reported separately)
omd doctor
omd --json doctor
```

Default output is a readable table. Use `--json` for machine-readable output or `--plain` for tab-separated values.

```bash
omd quote AAPL
omd --json quote AAPL
omd --plain quote AAPL
```

Force a specific source when reproducibility or provider comparison matters:

```bash
omd --source finnhub quote AAPL
omd --source worldbank macro get NY.GDP.MKTP.CD
```

## TypeScript API

```bash
npm install open-market-data
```

The high-level client registers providers for you and avoids the need to call the low-level router directly.

```ts
import { openMarketData } from 'open-market-data'

const quotes = await openMarketData.quotes(['AAPL', 'MSFT'])
console.log(quotes.data)
console.log(quotes.meta.sources ?? quotes.meta.source)

const snapshot = await openMarketData.snapshot({
  symbol: 'NVDA',
  historyDays: 30,
  financialPeriods: 4,
  filingLimit: 5,
})
console.log(snapshot.data)

const health = await openMarketData.health()
console.log(health.data)
```

Every high-level method is typed and returns the same response envelope:

```ts
type AgentToolResponse<T> = {
  data: T
  meta: {
    tool: AgentToolName
    retrievedAt: string
    request: Record<string, unknown>
    source?: string
    sources?: string[]
    cached?: boolean
    partial?: boolean
    warnings?: string[]
    errors?: Array<{ component: string; message: string }>
  }
}
```

Advanced users can import the MCP primitives from `open-market-data/mcp` and the browser adapter from `open-market-data/webmcp`.

## Experimental WebMCP adapter

WebMCP is an experimental W3C Community Group draft for exposing page-level JavaScript tools to browser agents. The adapter checks for browser support at runtime and otherwise does nothing.

The browser adapter does not bundle Node providers or expose API keys. Point it at a same-origin endpoint that runs the shared tool catalog:

```ts
import { registerOpenMarketDataWebMcp } from 'open-market-data/webmcp'

const registration = await registerOpenMarketDataWebMcp(async (name, input) => {
  const response = await fetch('/api/market-tools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  })
  if (!response.ok) throw new Error(`Market tool failed: ${response.status}`)
  return response.json()
})

console.log(registration.supported, registration.registered)
```

All registered browser tools are marked read-only, and their upstream content is marked untrusted.

## Data sources

By default, `omd` chooses an enabled provider for the requested capability and falls back to another one when possible.

| Source | API key | Main capabilities |
|---|---:|---|
| SEC EDGAR | No | Filings, XBRL financials, insider filings |
| Yahoo Finance | No | Quotes, search, financials, history, options, earnings, dividends |
| Binance | No | Crypto quotes and interval-aware candles where regionally available |
| World Bank | No | Global economic indicators |
| FRED | Free | US economic time series and search |
| CoinGecko | Optional free key | Keyless crypto market data and rankings; a key adds dedicated quota |
| Finnhub | Free | Quotes and earnings fallback |
| Alpha Vantage | Free | Quotes, financials, and history fallback |

Run `omd sources` or call `provider_status` to inspect capabilities without making network requests. Use `omd doctor` or `provider_health` for small live probes against all eight providers. The health report distinguishes missing keys, disabled sources, regional restrictions, transient outages, and invalid responses. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for rate limits and provider details.

## API keys and optional quotas

```bash
omd config set fredApiKey your_key_here
omd config set coingeckoApiKey your_key_here
omd config set finnhubApiKey your_key_here
omd config set alphaVantageApiKey your_key_here
```

Environment variables work too:

```bash
export FRED_API_KEY=...
export COINGECKO_API_KEY=...
export FINNHUB_API_KEY=...
export ALPHA_VANTAGE_API_KEY=...
```

Set `EDGAR_USER_AGENT` to a descriptive contact string for sustained SEC EDGAR usage.

## Agent skill fallback

Use MCP when the client supports it. For agents that can run commands but cannot connect to MCP, the package also includes a CLI skill at `skills/open-market-data/SKILL.md`.

```bash
# From a global npm installation
cp -r "$(npm root -g)/open-market-data/skills/open-market-data" ~/.claude/skills/

# From a clone
cp -r skills/open-market-data ~/.claude/skills/
```

## Development and testing

```bash
pnpm install
pnpm validate:plugin  # portable and ChatGPT/Codex manifest checks
pnpm test             # deterministic offline unit and protocol tests
pnpm test:live        # local checks against real upstream providers
pnpm check            # lint, typecheck, and offline tests
pnpm build
```

The default test suite does not use the network. It covers the agent catalog, runtime, provider-health classification, modern and legacy MCP behavior, stdio framing, WebMCP registration, routing and cache contracts, provider edge cases, and clean installation from the packed npm artifact.

Live checks live in `*.live.test.ts` files and run locally with `pnpm test:live`. Keeping them out of GitHub Actions avoids false alarms when a public provider is rate-limited, regionally restricted, or briefly inconsistent. Keyless providers always run; FRED, Finnhub, and Alpha Vantage tests run when their environment variables are configured.

To inspect the built MCP server interactively:

```bash
pnpm build
npx @modelcontextprotocol/inspector node dist/mcp-cli.js
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for provider contracts, agent-tool requirements, and test expectations. Report security issues through the process in [SECURITY.md](SECURITY.md).

## Data and safety notes

This project only reads data; it does not place trades. Upstream data may be delayed, revised, incomplete, or temporarily unavailable. Keep the returned provenance, verify consequential decisions against primary sources, and do not treat the output as investment advice.

## License

MIT
