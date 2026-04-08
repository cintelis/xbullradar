@include ../_agent-instructions/xbullradar/AGENTS.orchestrator.md
# xBullRadar — Agent Instructions

## Overview

Real-time stock and crypto sentiment analysis platform. Pulls X/Twitter posts for tickers, scores sentiment via Grok API (-1 bearish to +1 bullish), triggers webhook alerts on threshold crossings.

## Stack

- **Backend**: Node.js / TypeScript
- **Frontend**: React / Next.js (TradingView-style dark theme)
- **AI**: Grok API (xAI) — `grok-3-mini` for fast scoring, `grok-3` for deep analysis
- **Data**: X/Twitter posts via Grok's native x_search tools
- **Alerts**: Webhook (Slack, Discord, custom endpoints)
- **Charts**: TradingView Lightweight Charts or Chart.js

## Key APIs

- **xAI API**: `https://api.x.ai/v1/chat/completions` + `https://api.x.ai/v1/responses` (with x_search tool)
- **API Key**: `XAI_API_KEY` environment variable

## Sentiment Scoring

- Score range: -1.00 (bearish) to +1.00 (bullish)
- Factors: post content, author followers, engagement (likes/replies), verified status
- Model: `grok-3-mini` for batch scoring (fast + cheap)
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
