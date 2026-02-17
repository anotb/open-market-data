# open-market-data

Unified CLI for free financial data APIs. One command, multiple sources, smart routing.

## Sources

| Source | Key Required | Data |
|--------|-------------|------|
| SEC EDGAR | No | Filings, financials, insider transactions |
| Yahoo Finance | No | Stock quotes, historical prices |
| Binance | No | Crypto prices, candlesticks |
| CoinGecko | Free key | Crypto market data, rankings |
| FRED | Free key | Macroeconomic data (GDP, unemployment, etc.) |

## Install

```bash
npm install -g open-market-data
```

## Usage

```bash
omd search "Apple Inc"
omd quote AAPL
omd quote AAPL MSFT GOOGL
omd financials AAPL --period annual
omd filing AAPL --type 10-K --latest
omd crypto BTC
omd crypto top 10
omd macro GDP --start 2020-01-01
omd sources
```

## Output Formats

```bash
omd quote AAPL              # Markdown (default)
omd --json quote AAPL       # JSON
omd --plain quote AAPL      # Tab-separated
```

## Configuration

API keys are read from environment variables or `~/.omd/config.json`:

```bash
export FRED_API_KEY=your_key
export COINGECKO_API_KEY=your_key
```

## License

MIT
