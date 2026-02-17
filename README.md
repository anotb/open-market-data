# open-market-data

Unified CLI for free financial data APIs. One command, multiple sources, smart routing.

```bash
omd quote AAPL                        # Stock quote (auto-routes to best source)
omd financials AAPL --period annual   # Financial statements from SEC EDGAR
omd crypto BTC                        # Crypto price from Binance
omd macro GDP --limit 10              # Economic data from FRED
omd sources                           # Show all providers + status
```

## Data Sources

8 providers, all free. The router picks the best available source automatically and falls back on failure.

| Source | Auth | Rate Limit | Categories |
|--------|------|-----------|------------|
| [SEC EDGAR](https://www.sec.gov/edgar/sec-api-documentation) | None | 10/sec | search, financials, filing, insiders |
| [Yahoo Finance](https://github.com/gadicc/node-yahoo-finance2) | None | 60/min | search, quote, financials, history, options, earnings, dividends |
| [Binance](https://binance-docs.github.io/apidocs/spot/en/) | None | 1200/min | crypto |
| [CoinGecko](https://docs.coingecko.com/v3.0.1/reference/introduction) | Free key | 30/min | crypto, search |
| [FRED](https://fred.stlouisfed.org/docs/api/fred/) | Free key | 120/min | macro, search |
| [Finnhub](https://finnhub.io/docs/api) | Free key | 60/min | search, quote, earnings |
| [Alpha Vantage](https://www.alphavantage.co/documentation/) | Free key | 25/day | search, quote, financials, history |
| [World Bank](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392) | None | Unlimited | macro |

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for detailed provider documentation and the roadmap for additional sources.

## Install

```bash
npm install -g open-market-data
```

## Commands

### Equities

```bash
omd search "Apple Inc"                  # Search across all providers
omd quote AAPL                          # Real-time quote
omd quote AAPL MSFT GOOGL              # Multi-symbol (concurrent)
omd financials AAPL                     # Annual financial statements
omd financials AAPL -p quarterly        # Quarterly
omd history AAPL --days 30             # Price history (OHLCV)
omd earnings AAPL                       # Earnings history + estimates
omd dividends AAPL                      # Dividend history
omd options AAPL                        # Options chains
```

### SEC Filings

```bash
omd filing AAPL                         # Recent filings
omd filing AAPL --type 10-K --latest    # Latest 10-K
omd insiders AAPL                       # Insider transactions
```

### Crypto

```bash
omd crypto BTC                          # Price + market data
omd crypto top 10                       # Top coins by market cap
omd crypto history BTC --days 30        # OHLCV candles
```

### Macro / Economic

```bash
omd macro GDP                           # GDP time series from FRED
omd macro UNRATE --limit 12             # Last 12 unemployment readings
omd macro search "inflation"            # Search FRED/World Bank series
omd macro get NY.GDP.MKTP.CD --source worldbank   # World Bank indicator
```

### Utility

```bash
omd sources                             # All providers + status
omd config show                         # Current configuration
omd config set finnhubApiKey <key>      # Set API key
```

## Output Formats

```bash
omd quote AAPL              # Markdown tables (default)
omd --json quote AAPL       # JSON (for scripts/agents)
omd --plain quote AAPL      # Tab-separated (for piping)
```

### Force a specific source

```bash
omd quote AAPL --source finnhub
omd financials AAPL --source alphavantage
omd macro GDP --source worldbank
```

## Configuration

API keys can be set via environment variables, `.env` file, or the config command:

```bash
# Environment variables
export FRED_API_KEY=your_key
export COINGECKO_API_KEY=your_key
export FINNHUB_API_KEY=your_key
export ALPHA_VANTAGE_API_KEY=your_key

# Or use the config command (saves to ~/.omd/config.json)
omd config set fredApiKey your_key
omd config set coingeckoApiKey your_key
omd config set finnhubApiKey your_key
omd config set alphaVantageApiKey your_key
```

### Get free API keys

| Provider | Sign up |
|----------|---------|
| FRED | https://fredaccount.stlouisfed.org/apikeys |
| CoinGecko | https://www.coingecko.com/en/api/pricing |
| Finnhub | https://finnhub.io/register |
| Alpha Vantage | https://www.alphavantage.co/support/#api-key |

No API key needed for SEC EDGAR, Yahoo Finance, Binance, or World Bank.

## Agent Integration

This project includes an [Agent Skills](https://agentskills.io/home) skill definition, allowing AI agents to discover and use `omd` as a tool for financial data queries.

The `skills/open-market-data/SKILL.md` file follows the open Agent Skills standard. Copy it into your agent's skill directory:

| Agent | Skill Path |
|-------|-----------|
| Claude Code (project) | `.claude/skills/open-market-data/SKILL.md` |
| Claude Code (global) | `~/.claude/skills/open-market-data/SKILL.md` |
| GitHub Copilot | `.github/skills/open-market-data/SKILL.md` |

Or install via CLI:

```bash
npx agentskills install open-market-data
```

The skill gives agents access to all `omd` commands with `--json` output for structured responses.

## How Routing Works

When you run `omd quote AAPL`, the router:

1. Finds all providers that support the `quote` category
2. Filters to enabled providers (API key configured if required)
3. Sorts by priority (Yahoo > Finnhub > Alpha Vantage for quotes)
4. Tries the top provider; on failure, falls back to the next
5. Caches results to avoid redundant API calls

You can bypass routing with `--source`:

```bash
omd quote AAPL --source finnhub    # Skip Yahoo, go straight to Finnhub
```

## License

MIT
