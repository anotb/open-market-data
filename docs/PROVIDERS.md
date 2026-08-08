# Data Providers

## Active Providers

These providers are implemented and available in `omd`.

---

### SEC EDGAR

US Securities and Exchange Commission's Electronic Data Gathering, Analysis, and Retrieval system.

- **Auth:** None (User-Agent header recommended)
- **Rate limit:** 10 requests/second (IP-based)
- **Base URL:** `https://data.sec.gov/`
- **Docs:** https://www.sec.gov/edgar/sec-api-documentation
- **Categories:** search, financials, filing, insiders

**What it provides:**
- Company search via ticker/CIK mapping
- Full filing history (10-K, 10-Q, 8-K, all SEC forms)
- XBRL financial statements (revenue, net income, EPS, balance sheet, cash flows)
- Recent insider transactions normalized from issuer Form 4 ownership documents

**Key endpoints:**
- `/files/company_tickers.json` — Master CIK/ticker/name mapping
- `/submissions/CIK{padded}.json` — Company metadata + filing list
- `/api/xbrl/companyfacts/CIK{padded}.json` — All XBRL financial facts
- `/Archives/edgar/data/{cik}/{accession}/{document}.xml` — Form 4 ownership documents
- `efts.sec.gov/LATEST/search-index` — Full-text search across filings

---

### Yahoo Finance

Unofficial market data via the [yahoo-finance2](https://github.com/gadicc/node-yahoo-finance2) npm package.

- **Auth:** None
- **Rate limit:** ~60 requests/minute (unofficial, no hard documentation)
- **Docs:** https://github.com/gadicc/node-yahoo-finance2
- **Categories:** search, quote, financials, history, options, earnings, dividends

**What it provides:**
- Real-time stock quotes with market cap, 52-week range
- Historical OHLCV price data
- Quarterly/annual financial statements via fundamentalsTimeSeries
- Options chains (calls + puts with Greeks)
- Earnings history (actual vs estimate)
- Dividend history

**Note:** Unofficial API. May break without notice. The router uses Yahoo as primary for quotes and falls back to Finnhub/Alpha Vantage.

---

### Binance

World's largest crypto exchange. Public market data endpoints.

- **Auth:** None for public endpoints
- **Rate limit:** 1200 weight/minute
- **Base URL:** `https://data-api.binance.vision`
- **Docs:** https://github.com/binance/binance-spot-api-docs
- **Categories:** crypto

**What it provides:**
- Real-time crypto prices (USDT pairs)
- 24-hour ticker statistics (volume, high, low, change)
- OHLCV candlestick data (1m to 1M intervals)

**Note:** Geo-restricted in the US. Falls back to CoinGecko automatically.

---

### CoinGecko

Comprehensive crypto market data platform.

- **Auth:** Free API key (optional for basic, required for higher limits)
- **Rate limit:** 30 requests/minute (free tier)
- **Base URL:** `https://api.coingecko.com/api/v3/`
- **Docs:** https://docs.coingecko.com/v3.0.1/reference/introduction
- **Get API key:** https://www.coingecko.com/en/api/pricing
- **Categories:** crypto, search

**What it provides:**
- Crypto prices with market cap rankings
- Top N coins by market cap
- Historical OHLCV data with volume
- Coin search
- Trending coins
- Global crypto market stats

---

### FRED (Federal Reserve Economic Data)

800,000+ economic time series from the Federal Reserve Bank of St. Louis.

- **Auth:** Free API key required
- **Rate limit:** 120 requests/minute
- **Base URL:** `https://api.stlouisfed.org/fred/`
- **Docs:** https://fred.stlouisfed.org/docs/api/fred/
- **Get API key:** https://fredaccount.stlouisfed.org/apikeys
- **Categories:** macro, search

**What it provides:**
- Economic time series (GDP, unemployment, CPI, interest rates, housing, etc.)
- Series search across 800K+ indicators
- Series metadata (units, frequency, seasonal adjustment)
- Date range filtering and observation limits

**Common series IDs:** GDP, UNRATE, CPIAUCSL, FEDFUNDS, DGS10, MORTGAGE30US, HOUST

---

### Finnhub

Real-time stock data, news, and fundamentals.

- **Auth:** Free API key required
- **Rate limit:** 60 requests/minute
- **Base URL:** `https://finnhub.io/api/v1`
- **Docs:** https://finnhub.io/docs/api
- **Get API key:** https://finnhub.io/register
- **Categories:** search, quote, earnings

**What it provides:**
- Real-time stock quotes (price, change, day range)
- Symbol search
- Earnings history (actual vs estimate with surprise)

**Free tier limitations:** Historical candle data (OHLCV) requires a paid plan. The free tier is best for real-time quotes and earnings.

---

### Alpha Vantage

Broad market data coverage including equities, forex, and crypto.

- **Auth:** Free API key required
- **Rate limit:** 25 requests/day (free tier)
- **Base URL:** `https://www.alphavantage.co/query`
- **Docs:** https://www.alphavantage.co/documentation/
- **Get API key:** https://www.alphavantage.co/support/#api-key
- **Categories:** search, quote, financials, history

**What it provides:**
- Stock quotes (Global Quote endpoint)
- Symbol search
- Income statements and balance sheets (annual + quarterly)
- Daily historical price data

**Free tier limitations:** Only 25 requests per day. Best used as a fallback provider. The router gives Alpha Vantage the lowest priority for all categories.

**Error handling note:** Alpha Vantage returns HTTP 200 with errors in the JSON body (`Error Message`, `Note`, or `Information` fields). The provider checks for these before parsing data.

---

### World Bank

16,000+ development indicators with global coverage and 50+ years of history.

- **Auth:** None
- **Rate limit:** Unlimited (we self-impose 30/min to be polite)
- **Base URL:** `https://api.worldbank.org/v2`
- **Docs:** https://datahelpdesk.worldbank.org/knowledgebase/articles/889392
- **Categories:** macro

**What it provides:**
- Economic indicators for 200+ countries (GDP, unemployment, inflation, population, etc.)
- Search across 1,500+ World Development Indicators
- Annual data going back decades

**Common indicator IDs:**
- `NY.GDP.MKTP.CD` — GDP (current US$)
- `NY.GDP.MKTP.KD.ZG` — GDP growth (annual %)
- `SL.UEM.TOTL.ZS` — Unemployment (% of labor force)
- `FP.CPI.TOTL.ZG` — Inflation, CPI (annual %)
- `SP.POP.TOTL` — Population, total

**API note:** Default response format is XML. The provider adds `?format=json` to all requests. Responses are a two-element JSON array: `[pagination_metadata, data_array]`.

---

## Provider Priority

When multiple providers support the same category, the router picks them in priority order (lower number = higher priority):

| Category | Priority Order |
|----------|---------------|
| search | SEC EDGAR (2) → Yahoo (3) → CoinGecko (4) → FRED/Finnhub (5) → Alpha Vantage (6) |
| quote | Yahoo (1) → Finnhub (3) → Alpha Vantage (5) |
| financials | SEC EDGAR (1) → Yahoo (2) → Alpha Vantage (4) |
| history | Yahoo (1) → Alpha Vantage (4) |
| filing | SEC EDGAR (1) |
| insiders | SEC EDGAR (1) |
| options | Yahoo (1) |
| earnings | Yahoo (1) → Finnhub (2) |
| dividends | Yahoo (1) |
| macro | FRED (1) → World Bank (3) |
| crypto | Binance (1) → CoinGecko (2) |

---

## Coverage Matrix

What data you can get today, and which providers serve it:

| Data Type | Available Sources |
|-----------|-------------------|
| Stock quotes (real-time) | Yahoo, Finnhub, Alpha Vantage |
| Stock quotes (historical OHLCV) | Yahoo, Alpha Vantage |
| Company fundamentals (XBRL) | SEC EDGAR |
| Company fundamentals (parsed) | Yahoo, Alpha Vantage |
| SEC filings | SEC EDGAR |
| Insider transactions | SEC EDGAR |
| Options chains | Yahoo |
| Earnings (actual vs estimate) | Yahoo, Finnhub |
| Dividends | Yahoo |
| Crypto prices (real-time) | Binance, CoinGecko |
| Crypto market rankings | CoinGecko |
| Crypto OHLCV | Binance, CoinGecko |
| US economic data (GDP, CPI, etc.) | FRED |
| Global economic indicators | World Bank |
| Company/symbol search | SEC EDGAR, Yahoo, Finnhub, Alpha Vantage, CoinGecko |
