@include ../_agent-instructions/xbullradar/AGENTS.orchestrator.md
# xBullRadar — Agent Instructions

## Overview

Real-time stock and crypto sentiment analysis platform. Pulls X/Twitter posts for tickers, scores sentiment via Grok API (-1 bearish to +1 bullish), triggers webhook alerts on threshold crossings.

## Stack

- **Backend**: Node.js / TypeScript
- **Frontend**: React / Next.js (TradingView-style dark theme)
- **AI**: Grok API (xAI) — `grok-4-1-fast-reasoning` for fast scoring, `grok-4.20-reasoning` for deep analysis
- **Data**: X/Twitter posts via Grok's native x_search tools
- **Alerts**: Webhook (Slack, Discord, custom endpoints)
- **Charts**: TradingView Lightweight Charts or Chart.js

## Key APIs

- **xAI API**: `https://api.x.ai/v1/chat/completions` + `https://api.x.ai/v1/responses` (with x_search tool)
- **API Key**: `XAI_API_KEY` environment variable

## Environment Variables

All env vars live in `.env` locally (gitignored) and in Vercel project settings for production.

| Var | Required | Notes |
|---|---|---|
| `XAI_API_KEY` | yes | xAI Grok API key |
| `GROK_MODEL` | no | Default `grok-4.20-reasoning` (deep single-ticker analysis) |
| `GROK_MODEL_FAST` | no | Default `grok-4-1-fast-reasoning` (batch scoring) |
| Upstash credentials | prod | One of these pairs must be set to enable UpstashStore: `UPSTASH_REDIS_REST_URL`/`_TOKEN`, or `KV_REST_API_URL`/`_TOKEN`, or `<PREFIX>_KV_REST_API_URL`/`_TOKEN` (Vercel Marketplace integration with custom prefix). See `getUpstashConfig()` in `lib/store-upstash.ts`. |
| `CRON_SECRET` | prod | Required to call `/api/daily/scan`. Vercel Cron auto-injects `Authorization: Bearer ${CRON_SECRET}`. Local dev can omit it. |
| `ALERT_WEBHOOK_URL` | no | Slack/Discord webhook for sentiment crossing alerts |
| `BULLISH_THRESHOLD` | no | Default `0.5` |
| `BEARISH_THRESHOLD` | no | Default `-0.5` |
| `XBULLRADAR_STORE_PATH` | no | Override JsonFileStore path (local dev only). Default `./data/store.json` |

## Sentiment Scoring

- Score range: -1.00 (bearish) to +1.00 (bullish)
- Factors: post content, author followers, engagement (likes/replies), verified status
- Model: `grok-4-1-fast-reasoning` for batch scoring (fast + ~10x cheaper than flagship)
- Polling: every 15 min default, 5 min on high volatility

## Initial Tickers

- Stocks: $NVDA, $TSLA, $AAPL, $MSFT, $AMZN, $META, $GOOG
- Crypto: $BTC, $ETH, $SOL, $XRP

## Conventions

- TypeScript
- API key via environment variable
- WebSocket for real-time score streaming
- 90-day score history retention
- Rate limit aware: batch posts, cache results
