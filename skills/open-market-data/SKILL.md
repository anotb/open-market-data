---
name: open-market-data
description: Query free financial data APIs — stocks, crypto, macro, SEC filings
version: 0.1.0
tags: [finance, stocks, crypto, macro, sec, edgar, fred]
tools: [Bash]
metadata:
  openclaw: true
---

# open-market-data (omd)

Unified CLI for free financial data. Queries SEC EDGAR, Yahoo Finance, Binance, CoinGecko, and FRED behind a single interface with smart source routing.

## Quick Reference

```bash
# Stock quotes
omd quote AAPL
omd quote AAPL MSFT GOOGL        # concurrent multi-symbol

# Company search
omd search "Apple Inc"

# Financial statements (SEC EDGAR XBRL)
omd financials AAPL               # annual (default)
omd financials AAPL -p quarterly

# SEC filings
omd filing AAPL --type 10-K --latest
omd filing TSLA --type 8-K -l 5

# Insider transactions
omd insiders AAPL

# Crypto
omd crypto BTC                    # current price
omd crypto top 20                 # market rankings (CoinGecko)
omd crypto history ETH -d 30      # 30-day OHLCV

# Macroeconomic data (FRED)
omd macro get GDP --start 2020-01-01
omd macro search "unemployment rate"

# Output formats
omd --json quote AAPL             # JSON
omd --plain quote AAPL            # tab-separated

# Force specific source
omd quote AAPL --source yahoo
omd financials AAPL --source sec-edgar

# Bypass cache
omd --no-cache quote AAPL

# Source status
omd sources
```

## Sources

| Source | Key? | Best For |
|--------|------|----------|
| SEC EDGAR | No | Filings, XBRL financials, insider transactions |
| Yahoo Finance | No | Real-time quotes, search |
| Binance | No | Crypto prices (non-US only) |
| CoinGecko | Free key | Crypto rankings, broader coverage |
| FRED | Free key | GDP, unemployment, interest rates, 800K+ economic series |

## Configuration

API keys via env vars or `~/.omd/config.json`:

```bash
export FRED_API_KEY=your_key
export COINGECKO_API_KEY=your_key
export EDGAR_USER_AGENT="YourCompany you@email.com"

# Or use CLI
omd config set fredApiKey your_key
omd config set coingeckoApiKey your_key
```

## Output

Default output is markdown tables. Use `--json` for structured data or `--plain` for tab-separated values suitable for piping.

## How Routing Works

Commands route to the best available source automatically. If the top-priority source fails or is rate-limited, it falls back to alternatives. Use `--source <name>` to force a specific provider.
