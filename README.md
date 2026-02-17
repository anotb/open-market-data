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

## Agent Integration

This project includes an [Agent Skills](https://agentskills.io/home) skill definition, allowing AI agents to discover and use `omd` as a tool for financial data queries.

### How It Works

The `skills/open-market-data/SKILL.md` file follows the open Agent Skills standard. Compatible agents use progressive disclosure:

1. **Discovery** -- the agent reads the skill's name and description to know when it's relevant
2. **Activation** -- when a financial data task matches, the agent loads the full SKILL.md instructions
3. **Execution** -- the agent runs `omd` commands via Bash, following the skill's guidelines

### Installing the Skill

Copy the skill folder into your agent's skill directory:

| Agent | Skill Path |
|-------|-----------|
| Claude Code (project) | `.claude/skills/open-market-data/SKILL.md` |
| Claude Code (global) | `~/.claude/skills/open-market-data/SKILL.md` |
| GitHub Copilot | `.github/skills/open-market-data/SKILL.md` |
| Cursor / Other agents | Check your agent's skill directory docs |

Or use the CLI if your agent supports it:

```bash
npx agentskills install open-market-data
```

### What the Skill Provides

The skill gives agents access to stock quotes, SEC filings, financial statements, insider transactions, crypto prices, and macroeconomic data -- all through the `omd` CLI with `--json` output for structured responses.

### Example Agent Usage

When an agent loads this skill, it can handle requests like:

> "What are Apple's latest quarterly financials?"

The agent will run:

```bash
omd --json financials AAPL -p quarterly
```

and return the parsed results. The skill includes routing guidance, available commands, and output format options so the agent can pick the right command automatically.

## Configuration

API keys are read from environment variables or `~/.omd/config.json`:

```bash
export FRED_API_KEY=your_key
export COINGECKO_API_KEY=your_key
```

## License

MIT
