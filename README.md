# open-market-data

[![CI](https://github.com/anotb/open-market-data/actions/workflows/ci.yml/badge.svg)](https://github.com/anotb/open-market-data/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/open-market-data)](https://www.npmjs.com/package/open-market-data)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A portable Agent Plugin for read-only stock, company, SEC, crypto, and macroeconomic data. Use the same normalized data layer from Agent Skills, MCP, TypeScript, or the CLI.

```text
one package -> capability routing -> free public data sources -> normalized data + provenance
```

Stock, SEC, World Bank, and CoinGecko features work without an API key. Optional free keys add US macro data, dedicated crypto quota, and more fallback capacity.

## Why use it

- **Portable by default:** Agent Plugins 1.0.0 package with an Agent Skill and local stdio MCP server
- **Agent-safe:** explicit read-only tools with JSON Schemas, bounded results, and source metadata
- **Useful without setup:** stock, SEC, World Bank, and CoinGecko data work without keys; Binance is also keyless where regionally available
- **Resilient:** capability-based routing, provider fallback, rate-limit awareness, caching, and built-in source health checks
- **One implementation:** the same catalog powers the Agent Plugin, CLI, TypeScript API, MCP server, and experimental WebMCP adapter
- **Trustworthy by design:** every response identifies its source and whether it came from cache

## Install as an Agent Plugin

The repository root now follows the vendor-neutral **Agent Plugins 1.0.0** layout:

```text
plugin.json                     portable plugin identity
skills/open-market-data/        Agent Skills workflow
mcp.json                        portable local stdio MCP server
.codex-plugin/plugin.json       current ChatGPT/Codex compatibility
.mcp.json                       current ChatGPT/Codex bundled MCP config
```

Compatible clients can load the skill and MCP server from one package. The current ChatGPT/Codex compatibility files remain alongside the portable format so adoption does not depend on every client finishing migration at the same time.

After the npm release, ChatGPT/Codex users can add the repository marketplace:

```bash
codex plugin marketplace add anotb/open-market-data
```

The marketplace installs the compiled npm package. Source-checkout users should run `pnpm build` before loading the repository directly.

See [docs/AGENT-PLUGIN.md](docs/AGENT-PLUGIN.md) for package structure, validation, compatibility, and distribution details.

## Connect an AI agent

The package includes a built-in stdio MCP server with no separate service or MCP runtime dependency. It supports the current stateless `2026-07-28` protocol and session-based legacy clients, so existing agent hosts can adopt it without a compatibility proxy. The shortest setup is:

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

Agents receive seventeen narrow tools instead of an arbitrary shell command:

| Area | Tools |
|---|---|
| Discovery and diagnostics | `market_search`, `provider_status`, `provider_health` |
| Company research | `company_snapshot`, `stock_quotes`, `stock_financials`, `stock_history` |
| Events and derivatives | `stock_options`, `stock_earnings`, `stock_dividends` |
| SEC | `sec_filings`, `sec_insider_transactions` |
| Crypto | `crypto_quote`, `crypto_top`, `crypto_history` |
| Macro | `macro_series`, `macro_search` |

`company_snapshot` is the best starting point for company research. It returns a compact quote, recent performance, quarterly financials, earnings, and recent SEC filings in one call, with partial results if one upstream source is unavailable.

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

The high-level client registers providers automatically. It is safer and easier than calling the low-level router directly.

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

Every high-level method is fully typed and returns the same generic envelope:

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

WebMCP is an experimental W3C Community Group draft for exposing page-level JavaScript tools to browser agents. The adapter feature-detects the API and does nothing on unsupported browsers.

The browser adapter intentionally does not bundle Node providers or expose API keys. Point it at a same-origin endpoint that executes the shared tool catalog:

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

`omd` selects the best enabled provider for each capability and falls back when possible.

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

Run `omd sources` or call `provider_status` for a network-free capability inventory. Run `omd doctor` or call `provider_health` to make small live probes against all eight providers; missing optional keys, disabled sources, regional restrictions, transient unavailability, and invalid responses are reported as distinct states. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for rate limits and provider details.

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

MCP is preferred for clients that support it. The repository also ships a CLI skill at `skills/open-market-data/SKILL.md` for agents that can run shell commands but do not support MCP.

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
pnpm test:live    # real upstream provider smoke tests
pnpm check        # lint, typecheck, and offline tests
pnpm build
```

Default tests never require network access. They cover the agent catalog, typed runtime, provider-health classification, modern and legacy MCP behavior, stdio framing, WebMCP registration, provider-selection and cache-eligibility contracts, provider-specific edge cases, and a clean install from the packed npm artifact. Live checks are isolated in `*.live.test.ts` files and run on a scheduled GitHub Actions workflow, followed by a live smoke test from the packed artifact. Keyless sources, including CoinGecko's public API, always run; FRED, Finnhub, and Alpha Vantage run when their repository secrets are configured.

To inspect the built MCP server interactively:

```bash
pnpm build
npx @modelcontextprotocol/inspector node dist/mcp-cli.js
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for provider contracts, agent-tool requirements, and test expectations. Report security issues through the process in [SECURITY.md](SECURITY.md).

## Data and safety notes

This project is read-only and does not place trades. Upstream data can be delayed, revised, incomplete, or temporarily unavailable. Preserve the returned provenance, verify important decisions against primary sources, and do not treat the output as investment advice.

## License

MIT
