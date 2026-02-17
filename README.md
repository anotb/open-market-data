# open-market-data

Stock prices, financial statements, crypto, economic indicators — all from free public APIs. Works as a CLI tool or as a skill for AI agents.

```
$ omd quote AAPL

Symbol    : AAPL
Price     : $265.27
Change    : +$9.49 (+3.71%)
Volume    : 62M
Market Cap: $3.97T
Day Range : $255.00 — $266.29
Source    : yahoo
```

## Use with AI agents

If you use Claude Code, GitHub Copilot, or any agent that supports skills — `omd` comes with a skill file that teaches the agent how to use it. Your agent can then answer questions like "what are Apple's latest financials?" or "how has Bitcoin performed this month?" by running `omd` commands.

```bash
# If you installed globally, copy from the npm package
cp -r "$(npm root -g)/open-market-data/skills/open-market-data" ~/.claude/skills/

# Or if you cloned the repo
cp -r skills/open-market-data ~/.claude/skills/

# Or install with agentskills
npx agentskills install open-market-data
```

The skill file is at `skills/open-market-data/SKILL.md`. It tells the agent what commands are available, when to use `--json` for structured output, and how to pick the right command for a given question.

## Install

Requires Node.js 20 or later.

```bash
npm install -g open-market-data
```

No API keys are needed to get started. Stock quotes, financials, SEC filings, insider trades, and crypto prices all work immediately. Adding free API keys unlocks FRED economic data, CoinGecko rankings, Finnhub quotes, and Alpha Vantage as a fallback.

## What you can look up

**Stocks** — quotes, price history, financial statements, earnings, dividends, options chains

**SEC filings** — 10-K, 10-Q, 8-K, any form type. Insider transactions (Form 4).

**Crypto** — prices, market rankings, historical candles

**Economic data** — GDP, unemployment, inflation, interest rates, and thousands more series from FRED and the World Bank

## Examples

```bash
# Stock data
omd quote AAPL
omd quote AAPL MSFT GOOGL
omd financials AAPL
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

# Economic data
omd macro GDP
omd macro UNRATE --limit 12
omd macro search "inflation"
```

## Data sources

Everything is free. `omd` picks the best source automatically and tries the next one if it fails.

| Source | API Key | What it has |
|--------|---------|------------|
| SEC EDGAR | Not needed | Filings, financial statements (XBRL), insider trades |
| Yahoo Finance | Not needed | Stock quotes, price history, options, earnings, dividends |
| Binance | Not needed | Crypto prices and candles |
| World Bank | Not needed | Global economic indicators (GDP, unemployment, inflation) |
| FRED | Free | 800K+ US economic time series |
| CoinGecko | Free | Crypto market data and rankings |
| Finnhub | Free | Stock quotes, earnings |
| Alpha Vantage | Free | Stock quotes, financial statements, price history |

"Free" means you sign up and get a key at no cost. See [API keys](#api-keys) below.

Run `omd sources` to see which providers are active on your machine.

## API keys

Four sources need a free API key. The rest work out of the box.

| Source | Get a key here |
|--------|---------------|
| FRED | https://fredaccount.stlouisfed.org/apikeys |
| CoinGecko | https://www.coingecko.com/en/api/pricing |
| Finnhub | https://finnhub.io/register |
| Alpha Vantage | https://www.alphavantage.co/support/#api-key |

Add them with `omd config set`:

```bash
omd config set fredApiKey your_key_here
omd config set coingeckoApiKey your_key_here
omd config set finnhubApiKey your_key_here
omd config set alphaVantageApiKey your_key_here
```

Or put them in environment variables (`FRED_API_KEY`, `COINGECKO_API_KEY`, `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY`).

## Output formats

Default output is readable tables. Use `--json` for machine-readable output or `--plain` for tab-separated values.

```bash
omd quote AAPL              # human-readable
omd --json quote AAPL       # JSON
omd --plain quote AAPL      # tab-separated
```

You can force a specific source with `--source`:

```bash
omd quote AAPL --source finnhub
omd macro NY.GDP.MKTP.CD --source worldbank
```

## More provider details

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for full documentation on each data source, rate limits, and a list of additional sources we plan to add.

## License

MIT
