# xBullRadar — Technical Architecture

> **The AI-native Bloomberg terminal for the next generation of investors.**
>
> Multi-signal analytics, real-time X sentiment, conversational AI with
> investment-school voice personas, voice-activated portfolio rebalancing,
> and tokenized trading — in a single web app that costs $100/mo to run
> instead of $24,000/yr.
>
> Last updated: 2026-04-10

---

## Table of Contents

1. [Vision](#vision)
2. [What's Built vs What's Next](#whats-built-vs-whats-next)
3. [Tech Stack](#tech-stack)
4. [System Architecture](#system-architecture)
5. [Data Flow](#data-flow)
6. [External Services & Data Sources](#external-services--data-sources)
7. [API Surface](#api-surface)
8. [Signal Aggregation Engine](#signal-aggregation-engine)
9. [AI & Voice Architecture](#ai--voice-architecture)
10. [Auth System](#auth-system)
11. [Storage & Caching](#storage--caching)
12. [Deployment & Infrastructure](#deployment--infrastructure)
13. [Component Architecture](#component-architecture)
14. [Key Data Types](#key-data-types)
15. [Cost Structure](#cost-structure)
16. [Roadmap: From Trial to Bloomberg Replacement](#roadmap-from-trial-to-bloomberg-replacement)

---

## Vision

Bloomberg Terminal costs $24,000/year per seat. It was built in the
1980s for a world of dedicated hardware, proprietary data feeds, and
institutional traders who needed 50ms latency. Most of what retail and
mid-market investors actually use it for — quotes, news, portfolio
analytics, company fundamentals, earnings calendars — is now available
through public APIs at a fraction of the cost.

**xBullRadar is what a Bloomberg terminal would look like if you built
it today with AI at the core instead of bolted on the side.**

Instead of 30,000 keyboard shortcuts, you have a voice co-pilot that
thinks like Buffett, Lynch, or Greenblatt — and can execute trades on
your behalf with your permission. Instead of a firehose of raw data,
you have multi-signal intelligence that tells you whether a stock is
cheap vs bonds, whether the technicals confirm the fundamentals, and
whether X sentiment is aligned or diverging. Instead of a $2k/mo data
terminal, you have a $100/mo web app that runs on any browser.

The thesis: **the Bloomberg of the future is not a faster terminal —
it's a smarter analyst that talks to you.**

---

## What's Built vs What's Next

### Shipped (Trial v1)

| Capability | Bloomberg Equivalent | Status |
|-----------|---------------------|--------|
| Multi-signal stock analysis (4 independent signals per ticker) | PORT, FA, TECH | Shipped |
| Equity Risk Premium per stock + portfolio-level | — (Bloomberg doesn't compute this automatically) | Shipped |
| Real-time X/social sentiment scoring | — (Bloomberg has news, not social sentiment) | Shipped |
| AI co-pilot with investment-school voice switching | — (no equivalent) | Shipped |
| Voice agent with natural language portfolio rebalancing | — (no equivalent) | Shipped |
| Tokenized trading via Ondo Finance (263 tickers) | EMSX (execution management) | Shipped |
| Portfolio tracking with cash/stablecoin/bond allocations | PORT | Shipped |
| Commodities + crypto + forex + treasury yield ticker tape | TOP, WEI | Shipped |
| Global exchange clock with lunch-break awareness | WEXC | Shipped |
| Multi-category news feed (general/stock/crypto/forex) | NEWS, TOP | Shipped |
| Earnings calendar + beat/miss history per ticker | ERN, EA | Shipped |
| Magic-link auth with allowlist-gated trial access | — | Shipped |
| Chat export for conversation review | — | Shipped |

### Not Yet Built (Marked in Roadmap Below)

| Capability | Bloomberg Equivalent | Priority |
|-----------|---------------------|----------|
| X Breaking News in chat (real-time via Grok x_search) | BN, FIRST | High — next sprint |
| Stock screener (filter by signal combination) | EQS | High |
| Economic calendar (FOMC, CPI, NFP, earnings) | ECO | High |
| Portfolio analytics (Sharpe, beta, correlation, sector pie) | PORT analytics | High |
| Options chain + IV surface + unusual activity | OMON, OV | Medium |
| Brokerage integration (import holdings from Schwab/Fidelity) | AIM | Medium |
| International stocks (ASX, LSE, HKEX via Twelve Data) | Global coverage | Medium |
| Custom dashboard layouts (drag-and-drop panels) | LAUNCHPAD | Medium |
| Backtesting engine (test signal strategies on historical data) | BTST | Low |
| Fixed income analytics (yield curves, duration, convexity) | FI | Low |
| API access for quant integration | BQNT, DAPI | Future |

---

## Overview

xBullRadar is a web-first dark-themed fintech dashboard that helps
retail and professional investors make data-driven decisions by layering
four independent analytical signals per stock:

| Signal | Source | Method |
|--------|--------|--------|
| **Sentiment** | X (Twitter) via Grok x_search | Real-time social chatter scored -1.0 to +1.0 |
| **Technical** | Polygon historical OHLC | SMA/EMA/RSI/MACD/Bollinger majority vote |
| **Fundamental** | FMP financial statements | Valuation/profitability/growth/health/consistency buckets |
| **Equity Risk Premium** | FMP P/E + FMP treasury rates | Earnings yield minus 10Y treasury yield |

These signals combine into a single **Combined BUY/SELL/NEUTRAL** badge
per ticker, giving users an at-a-glance read on every position.

The platform integrates a conversational AI co-pilot (text + voice)
powered by xAI's Grok that can analyze the user's actual portfolio,
switch between investment philosophies (Buffett, Lynch, ARK, quant),
and execute portfolio changes through a two-stage commit pattern (bot
proposes, user confirms).

Trading is facilitated through **Ondo Finance**, which tokenizes US
stocks as on-chain assets — 263 tickers available as of April 2026.

**Codebase**: ~11,800 lines of TypeScript across 22 lib modules,
20 React components, and 17 API routes.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router) | 15.1 |
| UI | React | 19.0 |
| Language | TypeScript (strict mode) | 5.7 |
| Styling | Tailwind CSS | 4.0 |
| UI primitives | Radix UI (Dialog, Slot) | Latest |
| Icons | Lucide | 0.460 |
| Production DB | Upstash Redis (REST API) | 1.37 |
| PWA | Serwist (service worker) | 9.0 |
| Hosting | Vercel | — |
| AI/LLM | xAI Grok (Responses + Realtime) | grok-4.20-reasoning |
| Market data | FMP (Stocks Starter) | /stable/* |
| Price data | Polygon/Massive (Stocks Basic) | /v2/aggs/* |
| Trading | Ondo Finance | Static catalog |

**Zero external UI libraries** — no chart libs, no component frameworks
beyond Radix primitives. All signal badges, the ticker tape, the
portfolio table, and the voice transcript are custom Tailwind components.

---

## System Architecture

```
                    +------------------+
                    |   Vercel Edge    |
                    |  (Next.js 15)   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
        +-----+-----+  +----+----+  +------+------+
        | API Routes |  |  Pages  |  | Static/PWA  |
        | (17 routes)|  | (SSR)   |  | (Serwist)   |
        +-----+------+  +----+----+  +-------------+
              |              |
              |         +----+----+
              |         | React   |
              |         | Client  |
              |         | (20 TSX)|
              |         +---------+
              |
    +---------+---------+
    |  lib/ (22 modules)|
    |  Business Logic   |
    +----+----+----+----+
         |    |    |    |
    +----+ +--+  +-+  ++-------+
    |xAI  |FMP| |Poly| |Upstash|
    |Grok | API| |gon | |Redis  |
    +-----+----+ +---+ +-------+
```

**Key architectural decisions:**

1. **Single Next.js app** — no microservices, no separate API server.
   Route Handlers call external APIs directly. Simpler to deploy,
   debug, and iterate on during the trial phase.

2. **Upstash REST Redis** — no connection pooling needed. Works on
   any serverless host because it talks HTTPS, not TCP. Per-user data
   is keyed by userId; shared caches (prices, markets, news) are
   global.

3. **Browser-direct voice** — the Vercel route only mints an ephemeral
   xAI secret. All audio streaming happens over a WebSocket between
   the browser and `wss://api.x.ai/v1/realtime`. This minimizes
   latency and keeps the server stateless.

4. **Cache-first architecture** — every external API call goes through
   an Upstash cache with a tuned TTL. A nightly Vercel cron warms all
   caches proactively so morning users never hit cold fetches.

---

## Data Flow

### Price & Signal Pipeline

```
Polygon (EOD prices)                   FMP (fundamentals)
        |                                     |
   getDailyPrices()                   getFundamentalSignal()
   getHistoricalCloses()              fetchProfile() + fetchKeyMetrics()
        |                                     |
   Upstash 12h TTL                    Upstash 48h TTL
        |                                     |
        +----------+    +---------+-----------+
                   |    |         |
              computeTechnicalSignal()    aggregate()
              (SMA/EMA/RSI/MACD/BB)      (5 buckets + ERP)
                   |                          |
                   +------+---+---------------+
                          |   |
                   combineSignals(sentiment, tech, fund)
                          |
                   BUY / SELL / NEUTRAL
```

### User Request Flow

```
Browser → /api/portfolio GET
  → store.getHoldings(userId)      [Upstash: per-user]
  → store.getCash(userId)          [Upstash: per-user]
  → getDailyPrices()               [Upstash: 12h cache]
  → store.getAllLastSentiments()    [Upstash: persistent]
  → Enrich holdings with prices + sentiment
  → Compute totals (equity + cash, weighted ERP, weighted sentiment)
  → Return JSON

Browser → /api/technicals?tickers=NVDA,MSFT
  → For each ticker:
      → getHistoricalCloses(ticker) [Upstash: 7d cache → Polygon if cold]
      → computeTechnicalSignal(closes)  [Pure TS, no network]
  → Return { results: [...] }

Browser → /api/fundamentals?tickers=NVDA,MSFT
  → For each ticker:
      → getFundamentalSignal(ticker) [Upstash: 48h cache → FMP if cold]
  → Return { results: [...] }
```

### Voice Turn Flow

```
User clicks mic
  → POST /api/voice (mint ephemeral secret)
      → loadPortfolioContext(userId) [~200ms, all from cache]
      → Build instructions: INVESTING_SYSTEM_PROMPT
                           + VOICE_MODE_ADDENDUM
                           + portfolio snapshot
                           + Ondo URLs per holding
      → POST xAI /v1/realtime/client_secrets
      → Return { clientSecret, endpoint }

Browser opens WebSocket to wss://api.x.ai/v1/realtime
  → Audio streams both ways (pcm16, 24kHz)
  → Server VAD detects end-of-speech
  → Whisper transcribes input
  → Grok generates response + optional tool calls

If tool call (propose_holding_change):
  → Frontend renders ConfirmChangeCard
  → User clicks Confirm → PUT /api/portfolio
  → Dispatches portfolio:updated event → PortfolioView refreshes
```

---

## External Services & Data Sources

| Service | What it provides | Tier | Cost |
|---------|-----------------|------|------|
| **xAI Grok** | Sentiment scoring (x_search), conversational AI (Responses API), voice agent (Realtime API) | Paid | ~$50-100/mo at trial scale |
| **FMP** | Fundamentals (P/E, ROE, margins), earnings calendar, treasury yields, commodities, exchange hours, news (4 categories) | Stocks Starter | $14/mo fixed |
| **Polygon/Massive** | End-of-day OHLC prices, historical closes for technicals | Stocks Basic | Free |
| **Ondo Finance** | 263 tokenized stock/ETF tickers, deep-link trading URLs | Static catalog | Free (link integration) |
| **Upstash Redis** | Production persistence + multi-TTL caching | Pay-as-you-go | ~$10-20/mo |
| **Vercel** | Hosting, CDN, serverless functions, cron | Pro | ~$20/mo |
| **Cloudflare Workers** | Magic-link email delivery via M365 Graph API | Custom (365soft) | Included |

**Monthly cost at trial scale: ~$95-155/mo**

---

## API Surface

| Route | Method | Purpose | Auth |
|-------|--------|---------|------|
| `POST /api/auth/request` | Request magic-link sign-in | Public |
| `GET /auth/verify` | Consume magic-link, create session | Via token |
| `POST /api/auth/signout` | Revoke session | Cookie |
| `GET /api/portfolio` | Enriched holdings + cash + totals | Required |
| `PUT /api/portfolio` | Update holdings and/or cash | Required |
| `GET /api/watchlist` | Return user's watchlist | Required |
| `PUT /api/watchlist` | Replace watchlist | Required |
| `GET /api/sentiment/batch` | Last-known sentiment scores | Required |
| `POST /api/sentiment/batch` | Batch-score watchlist via Grok | Required |
| `GET /api/technicals` | Technical signal per ticker | Required |
| `GET /api/fundamentals` | Fundamental signal per ticker | Required |
| `GET /api/earnings` | Next earnings + beat history | Required |
| `GET /api/markets` | Commodities, exchanges, treasury yields | Required |
| `GET /api/news` | News by category (general/stock/crypto/forex) | Required |
| `POST /api/copilot` | Conversational AI (text chat) | Required |
| `POST /api/voice` | Mint xAI Realtime ephemeral secret | Required |
| `POST /api/daily/scan` | Nightly cron: warm all caches + batch scan | Bearer token |

---

## Signal Aggregation Engine

### Per-Ticker Signals

**Sentiment** (from Grok x_search):
- Score: -1.0 (panic selling) to +1.0 (euphoria)
- Derived signal: score > 0.2 = BUY, < -0.2 = SELL, else NEUTRAL
- Grounded in real-time X posts, not historical

**Technical** (computed from Polygon OHLC):
- 5 indicators, each votes BUY/SELL/NEUTRAL independently:
  - SMA: 50-day vs 200-day crossover
  - EMA: 12-day vs 26-day crossover
  - RSI: 14-period (>70 overbought, <30 oversold)
  - MACD: signal line crossover
  - Bollinger: price vs 20-day ± 2σ bands
- Final signal: majority vote (3/5 needed)
- Confidence: fraction of indicators that agree

**Fundamental** (from FMP financial statements):
- 5 buckets, each votes BUY/SELL/NEUTRAL:
  - Valuation: P/E, P/B, P/S vs sector-relative thresholds
  - Profitability: ROE, net margin vs sector medians
  - Growth: YoY revenue growth, YoY EPS growth (from annual income statements)
  - Health: debt/equity, current ratio, free cash flow
  - Consistency: earnings beat rate over last 4 quarters
- Sector-relative thresholds: static SECTOR_BASELINES table for 11 GICS sectors
- Final signal: majority vote

**Equity Risk Premium (ERP)**:
- Formula: `(1/PE × 100) - 10Y_treasury_yield`
- Thresholds: > 4% = CHEAP, 2-4% = FAIR, < 2% = RICH
- Historical US average: ~4-5%
- Interpretation: "is this stock paying you more than bonds?"

### Portfolio-Level Aggregation

- **Combined signal per ticker**: majority vote across sentiment, technical, fundamental
- **Portfolio ERP**: value-weighted average across all holdings + cash (cash contributes ERP=0, correctly diluting)
- **Weighted sentiment**: value-weighted average (cash contributes 0)
- **Total value**: equity positions + cash entries

---

## AI & Voice Architecture

### System Prompt Architecture

The bot's persona is defined in `lib/copilot/prompt.ts` (~200 lines):

**Base prompt** (`INVESTING_SYSTEM_PROMPT`):
- Persona: thoughtful buy-side analyst, not a chatbot
- Analytical framework: 6-step mental model that pros actually use
  1. ERP vs 10Y Treasury
  2. Sector-relative valuation
  3. Real growth (revenue + EPS YoY)
  4. Free cash flow yield
  5. Balance sheet safety
  6. Consensus story + beat/miss history
- Four investment lenses, switchable on request:
  - Value (Buffett, Munger, Greenblatt)
  - Growth (Lynch, ARK, Fisher)
  - Momentum / Trend
  - Quant / Factor
- Portfolio-aware: reads the user's actual holdings snapshot
- Ondo-aware: knows which holdings are tradeable as tokenized assets

**Voice addendum** (`VOICE_MODE_ADDENDUM`):
- Short replies (2-4 sentences per turn)
- Spoken number formatting ("four point two percent" not "4.2%")
- No markdown, no visual references
- Portfolio rebalancing tool instructions (two-stage commit rules)

### Portfolio Context Injection

Every conversational turn (text or voice) prepends a real-time snapshot
of the user's holdings to the message:

```
## Current portfolio snapshot

Total portfolio value: $781.7k
Allocation: 86% equity, 14% cash & equivalents

Equity holdings (sorted by position value):
- MSFT: 1200 sh @ $374.33 value $449.2k (57.5% of book) day +0.55%
  P/E 35.1, ERP 0.0%, Fund BUY, Tech NEUTRAL, sentiment 0.00,
  next earnings 2026-04-29, 75% beat rate, Ondo: https://app.ondo.finance/assets/msfton
- AMZN: 500 sh @ $221.25 value $110.6k (14.2% of book) day +3.50%
  ...

Cash & equivalents (treated as ERP=0, ~risk-free rate):
- Schwab brokerage [cash]: $100.0k (12.8% of book)
- USDC wallet [stablecoin]: $10.0k (1.3% of book)
```

This context costs ~80-120 tokens per holding, ~1k tokens for a
10-stock portfolio. The bot uses it to quote specific numbers, flag
concentration risks, warn about upcoming earnings, and suggest Ondo
trades — all grounded in real data.

### Voice Agent: Two-Stage Commit

The voice bot has a `propose_holding_change` tool for portfolio
rebalancing. The commit flow:

1. **User speaks intent**: "Trim NVDA to 40 shares"
2. **Bot gets verbal consent**: "That would take NVDA from 50 to 40 shares, freeing up about $1,400. Want me to go ahead?"
3. **User confirms**: "Yes, do it"
4. **Bot calls tool**: `propose_holding_change({ ticker: "NVDA", new_shares: 40, reason: "..." })`
5. **Frontend renders ConfirmChangeCard**: amber card with "NVDA: 50 → 40 shares" + Confirm/Cancel buttons
6. **Bot tells user**: "I've sent the proposal to your screen — click Confirm when ready"
7. **User clicks Confirm**: frontend PUTs to `/api/portfolio`, PortfolioView refreshes

The LLM never directly mutates portfolio state. Double consent
(verbal + physical click) prevents phantom trades from LLM
confabulation.

### Ondo Finance Integration

263 tokenized assets mapped from a static catalog (`lib/ondo.ts`).
Each portfolio holding is tagged with its Ondo URL (if available) in
the context snapshot, so the bot can say "you can buy tokenized MSFT
on Ondo Finance at app.ondo.finance/assets/msfton" without fabricating
URLs for tickers that aren't on the platform.

URL pattern: `https://app.ondo.finance/assets/{ticker_lowercase}on`

---

## Auth System

**Magic-link, stateless, allowlist-gated.**

```
User enters email → POST /api/auth/request
→ Check ALLOWED_EMAILS allowlist (trial gate)
→ Generate token (128 bits entropy, 15min TTL)
→ Send email via Cloudflare Worker → M365 Graph
→ Return generic "check your email"

User clicks link → GET /auth/verify?token={token}
→ Lookup + validate + consume token (single-use)
→ Create or lookup user record
→ Create session (24h TTL)
→ Set httpOnly secure cookie
→ Fire admin notification for new users
→ Redirect to dashboard

Subsequent requests:
→ getCurrentUser() reads session cookie
→ Lookup in Upstash/JSON → return User or 401
```

**ID format**: `{prefix}_{base36_timestamp}_{128bit_hex_random}`
- User: `usr_mns8ymz8_09e4bb1fa3be26101cdf41836ff689b2`
- Session: `sess_...`
- Magic link: `ml_...`

---

## Storage & Caching

### Upstash Redis Key Schema (Production)

**Per-user data** (persistent):
```
xbr:user:{userId}:watchlist          → JSON string[]
xbr:user:{userId}:holdings           → JSON PortfolioHolding[]
xbr:user:{userId}:cash               → JSON CashHolding[]
xbr:user:{userId}:sentiment:last     → Hash (ticker → JSON StockSentiment)
xbr:users                            → Set of all userIds
```

**Auth** (TTL-managed):
```
xbr:user:{userId}                    → JSON User            (persistent)
xbr:user:byEmail:{email}             → userId string        (persistent)
xbr:ml:{token}                       → JSON MagicLink       (15min TTL)
xbr:session:{sessionId}              → JSON Session          (24h TTL)
```

**Shared caches** (TTL-managed):
```
xbr:prices:daily                     → JSON CachedPrices     (12h TTL)
xbr:prices:history:{ticker}          → JSON HistoricalCloses  (7d TTL)
xbr:fundamentals:v6:{ticker}         → JSON FundamentalSignal (48h TTL)
xbr:earnings:v1:{ticker}             → JSON EarningsCache     (12h TTL)
xbr:markets:v5                       → JSON MarketsCache      (6h TTL)
xbr:news:v2:{category}               → JSON CachedNews        (5min TTL)
```

### Cache Warming Strategy

Daily at 14:00 UTC, the Vercel cron (`/api/daily/scan`) proactively
warms every cache layer:

1. Daily prices (Polygon grouped endpoint — all US stocks in 1 call)
2. Markets data (FMP commodities + exchange hours + treasury yields)
3. News (4 categories in parallel)
4. Per-user watchlist sentiment (Grok batch call using the fast model)
5. Historical closes for technicals (sequential, respects Polygon rate limit)
6. Fundamentals (sequential, respects FMP daily call limit)
7. Earnings calendar (sequential, 12h TTL covers quarter-to-quarter)

This ensures morning users hit warm caches. Cold fetches only happen
for tickers added after the last cron run.

### Cache Key Versioning

Cache keys include a version suffix (`v5`, `v6`, etc.) that bumps
whenever the cached data shape changes. This provides instant
invalidation on deploy — stale entries from the old version are
ignored (never read) and garbage-collected by their natural TTL. No
migration scripts needed.

### Client-side Storage

```
localStorage:
  xbullradar:chat:v1     → Chat history (text + folded voice transcripts)
  xbr:chatHidden         → Whether the chat panel is collapsed
  xbr:selectedExchange   → Last-selected exchange for the clock card
```

---

## Deployment & Infrastructure

### Vercel Configuration

```json
{
  "crons": [
    { "path": "/api/daily/scan", "schedule": "0 14 * * *" }
  ]
}
```

### Next.js Configuration

- Serwist PWA integration (service worker for offline + caching)
- Remote image pattern for Ondo asset logos
- Strict TypeScript, ES2022 target

### Environment Variables

**Required for production:**
```
XAI_API_KEY              # xAI Grok API key
FMP_API_KEY              # Financial Modeling Prep
POLYGON_API_KEY          # Polygon/Massive
UPSTASH_REDIS_REST_URL   # Upstash Redis REST endpoint
UPSTASH_REDIS_REST_TOKEN # Upstash Redis auth token
CF_ACCESS_CLIENT_ID      # Cloudflare Access service account
CF_ACCESS_CLIENT_SECRET  # Cloudflare Access service account
CRON_SECRET              # Bearer token for daily scan
```

**Optional:**
```
ALLOWED_EMAILS           # Trial allowlist (open if unset)
SESSION_TTL_HOURS        # Default 24
GROK_MODEL               # Default grok-4.20-reasoning
GROK_MODEL_FAST          # Default grok-4-1-fast-reasoning
ALERT_WEBHOOK_URL        # Slack/Discord for sentiment alerts
BULLISH_THRESHOLD        # Default 0.5
BEARISH_THRESHOLD        # Default -0.5
```

---

## Component Architecture

### Dashboard Layout

```
+----------------------------------------------------------+
| TopBar (branding + user menu + sign out)                  |
+----------------------------------------------------------+
| MarketStrip (horizontal scrolling ticker tape)            |
| S&P 500  NASDAQ  DOW  BTC  ETH  EUR/USD  Gold  3M  10Y  |
+----------------------------------------------------------+
|                              |                            |
|  main content (flex-1)       |  right sidebar (380px)     |
|                              |                            |
|  +------------------------+  |  +----------------------+  |
|  | SentimentRadar         |  |  | ExchangeClockCard    |  |
|  | (watchlist grid)       |  |  | (selected exchange)  |  |
|  +------------------------+  |  +----------------------+  |
|                              |                            |
|  +------------------------+  |  +----------------------+  |
|  | TrendingStocks         |  |  | NewsPanel            |  |
|  | (top movers by signal) |  |  |  OR                  |  |
|  +------------------------+  |  | CopilotChat          |  |
|                              |  | (text + voice)       |  |
|  +------------------------+  |  |                      |  |
|  | PortfolioView          |  |  | [Voice transcript]   |  |
|  | (holdings table)       |  |  | [ConfirmChangeCard]  |  |
|  | (cash & equivalents)   |  |  |                      |  |
|  +------------------------+  |  +----------------------+  |
|                              |  [Ask AI floating button]  |
+----------------------------------------------------------+
| BottomNav (mobile only — tab switcher)                    |
+----------------------------------------------------------+
```

### Mobile Layout

Tab-based navigation:
- **Dashboard**: ExchangeClockCard + SentimentRadar + TrendingStocks
- **Portfolio**: PortfolioView (full-height)
- **News**: NewsPanel (full-height)
- **Chat**: CopilotChat with voice support (full-height)

### Component Inventory (20 files)

| Component | Lines | Purpose |
|-----------|-------|---------|
| Dashboard | ~130 | Top-level layout, responsive, tab management |
| TopBar | ~60 | Branding, user menu |
| BottomNav | ~50 | Mobile tab switcher |
| MarketStrip | ~250 | Commodities/crypto/forex/yield ticker tape |
| ExchangeClockCard | ~400 | Exchange hours with lunch-break overrides |
| SentimentRadar | ~200 | Watchlist grid sorted by sentiment |
| TrendingStocks | ~500 | Top movers with full signal stack |
| PortfolioView | ~900 | Holdings table + cash section + totals + ERP |
| EditableNumber | ~190 | Reusable inline-edit numeric cell |
| SignalBadge | ~120 | BUY/SELL/NEUTRAL pill + Combined badge |
| EarningsBadge | ~100 | "Earnings in 3d" / "Beat 75%" pill |
| ERPBadge | ~100 | CHEAP/FAIR/RICH equity risk premium pill |
| NewsPanel | ~150 | Tabbed news feed (4 categories) |
| CopilotChat | ~500 | Text chat + voice toggle + export + proposals |
| VoiceMode | ~200 | Live transcript + connection status |
| ConfirmChangeCard | ~100 | Two-stage commit confirmation card |
| ActButton | ~80 | Deep-link to Ondo Finance trade page |
| SignInForm | ~100 | Magic-link email input |
| UserMenu | ~60 | Account dropdown |

---

## Key Data Types

### Portfolio

```typescript
interface PortfolioHolding {
  ticker: string;
  shares: number;
}

interface CashHolding {
  id: string;
  label: string;          // "Schwab brokerage", "USDC wallet"
  amount: number;         // USD value
  category: 'cash' | 'stablecoin' | 'bond' | 'other';
}
```

### Signals

```typescript
type Signal = 'BUY' | 'SELL' | 'NEUTRAL';

interface TechnicalSignal {
  signal: Signal;
  confidence: number;     // 0..1
  indicators: { sma, ema, rsi, macd, bollinger: Signal };
}

interface FundamentalSignal {
  signal: Signal;
  confidence: number;
  indicators: { valuation, profitability, growth, health, consistency: Signal };
  metrics: {
    peRatio, priceToBook, priceToSales: number | null;
    roe, netMargin, revenueGrowth: number | null;
    debtToEquity, currentRatio, freeCashFlow: number | null;
    earningsBeatRate: number | null;     // 0..1
    equityRiskPremium: number | null;    // percentage points
  };
}
```

### Sentiment

```typescript
interface StockSentiment {
  ticker: string;
  score: number;           // -1.0 to +1.0
  reasoning: string;
  responseId?: string;     // for stateful Grok turns
  citations?: string[];    // X post / web URLs
}
```

### Copilot

```typescript
interface CopilotResponse {
  message: string;
  ui?: { type: 'showActButton'; props: { ticker, ondoSymbol, sentimentScore, reasoning } };
  responseId?: string;
  citations?: string[];
}

interface PendingProposal {
  id: string;
  ticker: string;
  currentShares: number;
  newShares: number;
  reason: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'cancelled';
}
```

---

## Cost Structure

### Current (Trial Phase, ~5 Users)

| Item | Monthly Cost |
|------|-------------|
| xAI Grok (sentiment + copilot + voice) | $50-100 |
| FMP Stocks Starter | $14 |
| Polygon Stocks Basic | Free |
| Upstash Redis | $10-20 |
| Vercel Pro | $20 |
| Cloudflare Workers | Included |
| **Total** | **~$95-155** |

### Projected (100 Users)

| Item | Monthly Cost |
|------|-------------|
| xAI Grok | $300-500 |
| FMP (may need upgrade) | $14-50 |
| Upstash Redis | $50-100 |
| Vercel Pro | $20-50 |
| **Total** | **~$385-700** |

**Per-user cost at 100 users: ~$4-7/mo**

### Cost Levers

- **Voice is the expensive modality**: $0.05/min = $3/hr per active session. A heavy voice user doing 30 min/day = ~$45/mo just in voice. Text is ~100x cheaper per interaction.
- **Grok batch model** (grok-4-1-fast-reasoning) is ~10x cheaper than the deep reasoning model — used for nightly cron scans where latency doesn't matter.
- **FMP call budget**: 250 calls/day on Starter. With 50 tickers and 5 endpoints per ticker, that's the ceiling for fundamentals warming. Beyond that, upgrade to Standard ($30/mo) or cache more aggressively.

---

## Roadmap: From Trial to Bloomberg Replacement

### Phase 1 — Intelligence Layer (Current Sprint, April 2026)

The foundation: multi-signal analytics + AI co-pilot that actually
knows your portfolio. This is what we're shipping to trial users now.

| Feature | Effort | Status | Bloomberg Eq. |
|---------|--------|--------|---------------|
| 4-signal stock analysis (sentiment, tech, fund, ERP) | — | Shipped | PORT+FA+TECH |
| Voice co-pilot with investment-school personas | — | Shipped | — (no equiv.) |
| Voice-activated portfolio rebalancing (two-stage commit) | — | Shipped | — |
| Portfolio cash/stablecoin/bond tracking | — | Shipped | PORT |
| Ondo Finance tokenized trading (263 tickers) | — | Shipped | EMSX |
| Inline-edit holdings (click to change shares) | — | Shipped | PORT |
| Chat export to text file | — | Shipped | — |
| **X Breaking News in chat** | ~2-3h | **Next** | BN, FIRST |
| Server-side chat history (Upstash) | ~2-3h | Queued | — |
| Mobile voice polish (iOS Safari) | ~1-2h | Queued | — |

**X Breaking News** is the highest-priority unbuilt feature. Bloomberg
charges $24k/yr partly for BN (Bloomberg News) and FIRST (first-to-
report alerts). We can surface breaking news from X in real-time via
the existing Grok x_search integration — the infrastructure is already
there (the sentiment scanner and voice bot both use x_search). The
missing piece is a dedicated news panel that streams breaking headlines
and lets the bot proactively alert on market-moving events.

Implementation plan:
- Add a "Breaking" tab to the existing NewsPanel
- Call Grok with x_search scoped to the user's watchlist tickers
- Show timestamped headline cards with source X posts
- Voice bot can reference breaking news when answering "what just
  happened with NVDA?"
- Alert pipeline: if a breaking event crosses a significance threshold,
  push to the Slack/Discord webhook (existing ALERT_WEBHOOK_URL infra)

### Phase 2 — Analytics & Screening (May-June 2026)

The features that turn xBullRadar from "portfolio tracker" into
"analytical workstation."

| Feature | Effort | Bloomberg Eq. | Value |
|---------|--------|---------------|-------|
| **Stock screener** | ~6-8h | EQS | Filter the FMP universe by signal combination: "show me stocks with CHEAP ERP + BUY fundamentals + positive sentiment." This is the feature that makes users come back daily. |
| **Economic calendar** | ~4-6h | ECO | FOMC dates, CPI/NFP releases, earnings weeks. Overlay on the portfolio view so users see "3 of your holdings report this week." |
| **Portfolio analytics** | ~8-12h | PORT analytics | Sector allocation pie chart, concentration heatmap, Sharpe ratio, max drawdown, rolling beta vs S&P. Chart lib: lightweight (e.g. Recharts or Nivo). |
| **Cost basis + P&L** | ~4-6h | PORT P&L | Buy price per holding → unrealized gain/loss, tax lot tracking. The data model is just an optional `costBasis` field on PortfolioHolding. |
| **Watchlist alerts** | ~3-4h | ALRT | "Alert me when NVDA sentiment drops below -0.3" or "when QCOM ERP goes above 4%." Push via service worker + existing webhook. |
| **Multi-portfolio** | ~4-6h | PRTU | Separate books: "Growth", "Dividend", "Crypto". Each with independent holdings, signals, ERP, cash. |

### Phase 3 — Market Coverage Expansion (July-August 2026)

Bloomberg's moat is breadth — stocks, bonds, FX, commodities, options,
across every exchange globally. We chip away at this systematically.

| Feature | Effort | Bloomberg Eq. | Value |
|---------|--------|---------------|-------|
| **International stocks** | ~3-4h | Global equities | Twelve Data ($29/mo) or EODHD ($19.99/mo) as secondary vendor. ASX, LSE, HKEX, TSX, Euronext. Route by exchange suffix. |
| **Options chain** | ~12-16h | OMON, OV | IV surface, put/call ratio, unusual activity detection. Data source: CBOE or Tradier API. Voice bot can say "the put/call ratio on NVDA is elevated — someone's hedging." |
| **Fixed income analytics** | ~8-12h | FI, YAS | Yield curve visualization (we already have treasury rates), spread analysis, duration/convexity for bond holdings. Upgrade the existing `bond` cash category to real bond instruments. |
| **Crypto deep-dive** | ~6-8h | CRYP | We track BTC/ETH prices already. Add: on-chain metrics (via Glassnode or DeFiLlama), DEX volumes, stablecoin flows. Voice bot becomes a crypto analyst too. |
| **Forex analytics** | ~4-6h | FX | Extend the existing EUR/USD, GBP/USD, JPY/USD ticker tape tickers into full cross-pair analytics with interest rate differentials. |

### Phase 4 — Platform & Distribution (Q4 2026)

The features that make xBullRadar a platform, not just an app.

| Feature | Effort | Bloomberg Eq. | Value |
|---------|--------|---------------|-------|
| **Brokerage integration** | ~20-40h | AIM, EMSX | Plaid for account linking → import real holdings from Schwab, Fidelity, Interactive Brokers, Robinhood. Eliminates manual entry. The single biggest UX unlock. |
| **Custom dashboard layouts** | ~12-20h | LAUNCHPAD | Drag-and-drop panels: "I want news top-left, portfolio center, voice bottom-right." Saved per user. |
| **Auto-rebalance scheduler** | ~8-12h | RBAL | "Keep NVDA at 10% of book" → bot proposes trades when drift exceeds threshold. Runs on cron, proposes via the existing ConfirmChangeCard. |
| **Social / collaborative** | ~12-20h | IB chat, MSG | Share portfolio snapshots, follow other users' signal combinations, anonymized leaderboard. The "FinTwit inside the terminal" play. |
| **API access for quants** | ~8-12h | BQNT, DAPI | REST API exposing signals, sentiment scores, ERP data for programmatic consumption. Opens the B2B channel. |
| **Backtesting engine** | ~20-30h | BTST | "If I had followed the Combined signal for the last 2 years, what would my returns be?" Requires historical signal computation + return attribution. |

### Phase 5 — Enterprise & Monetization

| Path | Model | Target |
|------|-------|--------|
| **Freemium SaaS** | Free (5 tickers, text-only, delayed signals) → Pro ($15-25/mo: unlimited tickers, voice, real-time, Ondo) → Team ($50/seat/mo: shared portfolios, API access) | Retail investors, RIAs, family offices |
| **White-label** | License the signal engine + copilot prompt framework to other fintech apps. They bring UI + users, we bring intelligence. | Neobanks, trading apps, robo-advisors |
| **Data product** | Aggregated X sentiment data feed (anonymized, 15-min delayed) for institutional quant funds. The "alternative data" play. | Hedge funds, prop shops |
| **Ondo revenue share** | Commission on trades executed through the deep-link integration. 263 tokenized assets × user base = measurable GMV. | Ondo Finance partnership |
| **Enterprise terminal** | On-prem or VPC deployment for compliance-sensitive firms. Bloomberg replacement at 1/10th the cost. | Asset managers, banks |

### The Bloomberg Comparison

| Dimension | Bloomberg Terminal | xBullRadar |
|-----------|------------------|------------|
| **Price** | $24,000/yr/seat | ~$100/mo to run (infrastructure) |
| **AI** | Bolted-on GPT wrapper (2024) | AI-native: Grok co-pilot with investment-school voice personas, portfolio-aware reasoning, voice rebalancing |
| **Social sentiment** | News wire + limited Twitter | Real-time X sentiment scoring via x_search, grounded in actual posts with citations |
| **Voice** | None (Bloomberg TV is separate) | Built-in voice agent: ask questions, get analysis, execute trades — hands-free |
| **Trading** | EMSX (institutional) | Ondo Finance (tokenized, on-chain, accessible to retail) |
| **Signals** | Raw data — user does the analysis | Pre-computed multi-signal intelligence: technical + fundamental + sentiment + ERP, combined into actionable BUY/SELL/NEUTRAL |
| **Open/closed** | Proprietary terminal, vendor lock-in | Web app, PWA, future API access, data portability |
| **Deployment** | Dedicated hardware + network | Any browser, any device, Vercel edge |
| **Time to value** | Weeks of training | Sign in → portfolio populated → signals computed → voice analyst ready in minutes |

**The honest gap**: Bloomberg has 40 years of data depth, direct
exchange feeds with microsecond latency, and a network effect of
350,000 terminal users who chat on Bloomberg MSG. We don't compete
on those dimensions — we compete on intelligence, accessibility, cost,
and the AI-native experience that Bloomberg can't retrofit onto a
1980s architecture.

---

*Built with Next.js 15, React 19, xAI Grok, and Upstash Redis.
~11,800 lines of TypeScript. Deployed on Vercel.
Infrastructure cost: ~$100/mo. Bloomberg equivalent: ~$2,000/mo.*
