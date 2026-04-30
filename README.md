# xBullRadar

> **The AI-native Bloomberg terminal for the next generation of investors.**
>
> Multi-signal stock analytics, real-time X sentiment, conversational AI with
> investment-school voice personas, voice-activated portfolio rebalancing, and
> tokenized trading via Ondo Finance — in a single web app that costs ~$100/mo
> to run instead of $24,000/yr per seat.

[**Live app**](https://app.xbullradar.com) ·
[**Investor pitch deck (PDF, with screenshots)**](https://app.xbullradar.com/investors/xBullRadar-Pitch-Deck.pdf) ·
[**Architecture deep-dive**](./ARCHITECTURE.md)

---

## What it does

xBullRadar layers **four independent analytical signals** on every ticker in
your portfolio and watchlist, then combines them into a single actionable
verdict:

| Signal | Source | Method |
|---|---|---|
| **Sentiment** | X (Twitter) via Grok `x_search` | Real-time social chatter scored −1.0 to +1.0 |
| **Technical** | Polygon historical OHLC | SMA / EMA / RSI / MACD / Bollinger majority vote |
| **Fundamental** | FMP financial statements | Valuation / profitability / growth / health / consistency |
| **Equity Risk Premium** | FMP P/E + 10Y treasury yield | Earnings yield minus risk-free rate |

A conversational AI co-pilot (text + voice) powered by **xAI Grok** can read
your actual holdings, switch between investment philosophies (Buffett, Lynch,
ARK, quant), and execute portfolio rebalancing through a two-stage commit
pattern (bot proposes, you confirm).

Trading is facilitated through **Ondo Finance**, which tokenizes US stocks as
on-chain assets — 263 tickers available as of April 2026.

---

## System architecture

```mermaid
flowchart TB
    Browser["Browser (React 19 + PWA)"]

    subgraph Vercel["Vercel Edge — Next.js 15 App Router"]
        Pages["Pages (SSR)"]
        API["17 API Route Handlers"]
        Cron["Daily Cron — /api/daily/scan"]
    end

    subgraph Lib["lib/ — 22 modules of business logic"]
        Sentiment["sentiment.ts"]
        Technicals["technicals.ts"]
        Fundamentals["fundamentals.ts"]
        Prices["prices.ts"]
        Copilot["copilot/*"]
        Store["store-upstash.ts"]
    end

    subgraph External["External services"]
        Grok["xAI Grok<br/>Responses + Realtime + x_search"]
        FMP["Financial Modeling Prep<br/>fundamentals, earnings, news"]
        Polygon["Polygon / Massive<br/>EOD prices, OHLC history"]
        Ondo["Ondo Finance<br/>tokenized asset catalog"]
    end

    Upstash[("Upstash Redis<br/>per-user data + multi-TTL caches")]
    CFWorker["Cloudflare Worker<br/>magic-link email"]

    Browser -- "HTTPS / cookies" --> Pages
    Browser -- "fetch" --> API
    Browser -. "WebSocket (audio pcm16)" .-> Grok

    API --> Lib
    Cron --> Lib

    Sentiment --> Grok
    Copilot --> Grok
    Technicals --> Prices
    Prices --> Polygon
    Fundamentals --> FMP
    Lib --> Store
    Store --> Upstash
    Lib --> Ondo

    API -- "magic-link" --> CFWorker
```

**Key architectural decisions:**

1. **Single Next.js app** — no microservices, no separate API server. Route
   Handlers call external APIs directly. Easier to deploy, debug, and iterate
   on during the trial phase.
2. **Upstash REST Redis** — no connection pooling needed. Talks HTTPS, works
   on any serverless host. Per-user data keyed by `userId`; shared caches
   (prices, markets, news) are global.
3. **Browser-direct voice** — the Vercel route only mints an ephemeral xAI
   secret. All audio streaming happens over a WebSocket between the browser
   and `wss://api.x.ai/v1/realtime`. Minimizes latency, keeps the server
   stateless.
4. **Cache-first** — every external API call goes through an Upstash cache
   with a tuned TTL. A nightly Vercel cron warms all caches proactively so
   morning users never hit cold fetches.

---

## Signal pipeline

How a single ticker turns into a `BUY` / `SELL` / `NEUTRAL` verdict:

```mermaid
flowchart LR
    subgraph Sources["Data sources"]
        X["X / Twitter posts"]
        OHLC["Polygon OHLC history"]
        FS["FMP financial statements"]
        Treasury["10Y Treasury yield"]
    end

    subgraph Compute["Per-ticker computation"]
        Sent["Sentiment<br/>−1.0 ↔ +1.0"]
        Tech["Technical signal<br/>5 indicators majority vote"]
        Fund["Fundamental signal<br/>5 buckets majority vote"]
        ERP["Equity Risk Premium<br/>(1/PE × 100) − 10Y"]
    end

    subgraph Combine["Aggregation"]
        Combined["Combined signal<br/>BUY / SELL / NEUTRAL"]
        Portfolio["Portfolio-level<br/>weighted ERP + sentiment"]
    end

    X -- "Grok x_search" --> Sent
    OHLC -- "SMA / EMA / RSI / MACD / Bollinger" --> Tech
    FS -- "valuation / profit / growth / health / consistency" --> Fund
    FS --> ERP
    Treasury --> ERP

    Sent --> Combined
    Tech --> Combined
    Fund --> Combined
    ERP --> Combined

    Combined --> Portfolio
```

Each layer is intentionally independent so divergence is visible — a stock
with bullish fundamentals but bearish sentiment surfaces as a clear yellow
flag, not a smoothed-out average.

---

## Data flow — a single request

```mermaid
sequenceDiagram
    participant U as User browser
    participant V as Vercel route<br/>/api/portfolio
    participant R as Upstash Redis
    participant P as Polygon
    participant G as Grok x_search

    U->>V: GET /api/portfolio (cookie session)
    V->>R: get holdings + cash + last sentiment
    R-->>V: per-user data
    V->>R: get cached daily prices
    alt cache hit (12h TTL)
        R-->>V: prices
    else cache miss
        V->>P: grouped daily prices (1 call, all US stocks)
        P-->>V: OHLC
        V->>R: SET prices (12h TTL)
    end
    V->>V: enrich holdings with prices + sentiment<br/>compute weighted ERP, totals
    V-->>U: JSON { holdings, cash, totals }

    Note over U,G: Sentiment is refreshed asynchronously
    U->>V: POST /api/sentiment/batch
    V->>G: Grok x_search per ticker (fast model)
    G-->>V: scored posts + citations
    V->>R: SET sentiment (persistent)
    V-->>U: { results }
```

---

## Voice rebalancing — two-stage commit

The voice agent never directly mutates portfolio state. Verbal consent +
physical click prevents phantom trades from LLM confabulation.

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant V as Vercel /api/voice
    participant XAI as xAI Realtime<br/>(WebSocket)

    U->>B: click mic
    B->>V: POST /api/voice
    V->>V: loadPortfolioContext(userId)<br/>build system prompt + holdings + Ondo URLs
    V->>XAI: POST /v1/realtime/client_secrets
    XAI-->>V: { clientSecret, endpoint }
    V-->>B: ephemeral secret

    B->>XAI: open WebSocket (pcm16, 24kHz)
    U->>B: 🎙 "Trim NVDA to 40 shares"
    B->>XAI: audio stream
    XAI-->>B: "That takes NVDA from 50 → 40, freeing ~$1,400. Go ahead?"
    U->>B: 🎙 "Yes"

    XAI->>B: tool_call propose_holding_change<br/>{ ticker: NVDA, new_shares: 40 }
    B->>B: render ConfirmChangeCard (amber)
    XAI-->>B: "I sent the proposal — click Confirm"

    U->>B: click Confirm
    B->>V: PUT /api/portfolio
    V->>V: persist holdings → Upstash
    V-->>B: 200 OK
    B->>B: dispatch portfolio:updated → views refresh
```

---

## Data sources & cost

| Service | What it provides | Tier | Cost |
|---|---|---|---|
| **xAI Grok** | Sentiment scoring (`x_search`), conversational AI (Responses API), voice agent (Realtime API) | Paid | ~$50–100/mo at trial scale |
| **Financial Modeling Prep** | Fundamentals (P/E, ROE, margins), earnings calendar, treasury yields, commodities, exchange hours, news (4 categories) | Stocks Starter | $14/mo |
| **Polygon / Massive** | End-of-day OHLC prices, historical closes for technicals | Stocks Basic | Free |
| **Ondo Finance** | 263 tokenized stock/ETF tickers, deep-link trading URLs | Static catalog | Free |
| **Upstash Redis** | Production persistence + multi-TTL caching | Pay-as-you-go | ~$10–20/mo |
| **Vercel** | Hosting, CDN, serverless functions, cron | Pro | ~$20/mo |
| **Cloudflare Workers** | Magic-link email delivery via M365 Graph API | Custom | Included |

**Total infrastructure: ~$95–155/mo** at trial scale. Per-user cost projects to
**$4–7/mo at 100 users**.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19 + Tailwind CSS 4 + Radix primitives + Lucide icons |
| Language | TypeScript 5.7 (strict) |
| AI / LLM | xAI Grok — `grok-4.20-reasoning` (deep), `grok-4-1-fast-reasoning` (batch) |
| Voice | xAI Realtime API (WebSocket, pcm16 @ 24 kHz) |
| Storage | Upstash Redis (REST API) |
| PWA | Serwist 9 service worker |
| Hosting | Vercel (edge + cron) |
| Auth | Magic-link, allowlist-gated, M365 Graph via Cloudflare Worker |

**Zero external chart libraries.** All signal badges, the ticker tape, the
portfolio table, and the voice transcript are custom Tailwind components.

Codebase: ~11,800 lines of TypeScript across 22 lib modules, 20 React
components, 17 API routes.

---

## API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/request` | POST | Send magic-link email |
| `/auth/verify` | GET | Consume magic-link → create session |
| `/api/auth/signout` | POST | Revoke session |
| `/api/portfolio` | GET / PUT | Enriched holdings + cash + totals |
| `/api/watchlist` | GET / PUT | User's watchlist |
| `/api/sentiment/batch` | GET / POST | Last-known scores / re-score via Grok |
| `/api/technicals` | GET | Per-ticker technical signal |
| `/api/fundamentals` | GET | Per-ticker fundamental signal |
| `/api/earnings` | GET | Next earnings + beat history |
| `/api/markets` | GET | Commodities, exchanges, treasury yields |
| `/api/news` | GET | News by category |
| `/api/copilot` | POST | Conversational AI (text) |
| `/api/voice` | POST | Mint xAI Realtime ephemeral secret |
| `/api/daily/scan` | POST | Nightly cron — warm caches + batch scan |

All user-facing routes require a session cookie. The cron route is
authenticated via `Authorization: Bearer ${CRON_SECRET}` (Vercel injects this
automatically).

---

## Cache layout

```mermaid
flowchart LR
    subgraph User["Per-user (persistent)"]
        UW["xbr:user:{id}:watchlist"]
        UH["xbr:user:{id}:holdings"]
        UC["xbr:user:{id}:cash"]
        US["xbr:user:{id}:sentiment:last"]
    end

    subgraph Auth["Auth (TTL-managed)"]
        SU["xbr:user:{id} — User"]
        EM["xbr:user:byEmail:{email}"]
        ML["xbr:ml:{token} — 15 min"]
        SE["xbr:session:{id} — 24 h"]
    end

    subgraph Shared["Shared caches (TTL-managed)"]
        PR["xbr:prices:daily — 12 h"]
        PH["xbr:prices:history:{ticker} — 7 d"]
        FU["xbr:fundamentals:v6:{ticker} — 48 h"]
        EA["xbr:earnings:v1:{ticker} — 12 h"]
        MK["xbr:markets:v5 — 6 h"]
        NW["xbr:news:v2:{cat} — 5 min"]
    end
```

Cache keys carry a **version suffix** (`v5`, `v6`…) that bumps whenever the
cached shape changes — instant invalidation on deploy without migration
scripts. Stale entries are simply ignored and garbage-collected by their
natural TTL.

---

## Getting started

### Prerequisites

- Node.js ≥ 20
- An xAI API key (Grok)
- An FMP API key (Stocks Starter tier)
- A Polygon API key (Stocks Basic free tier is enough)
- An Upstash Redis instance (or skip for local-only `data/store.json`)

### Local development

```bash
git clone https://github.com/cintelis/xbullradar.git
cd xbullradar
npm install
cp .env.example .env   # then fill in the keys below
npm run dev
```

### Required environment variables

```bash
XAI_API_KEY=...                    # xAI Grok
FMP_API_KEY=...                    # Financial Modeling Prep
POLYGON_API_KEY=...                # Polygon / Massive
UPSTASH_REDIS_REST_URL=...         # Upstash Redis REST endpoint
UPSTASH_REDIS_REST_TOKEN=...
CRON_SECRET=...                    # Bearer token for /api/daily/scan
CF_ACCESS_CLIENT_ID=...            # magic-link email worker
CF_ACCESS_CLIENT_SECRET=...
```

### Optional

```bash
ALLOWED_EMAILS=alice@x.com,bob@y.com   # trial allowlist (open if unset)
GROK_MODEL=grok-4.20-reasoning         # deep model
GROK_MODEL_FAST=grok-4-1-fast-reasoning # batch model
ALERT_WEBHOOK_URL=...                  # Slack/Discord sentiment alerts
BULLISH_THRESHOLD=0.5
BEARISH_THRESHOLD=-0.5
SESSION_TTL_HOURS=24
```

The full env reference lives in [`AGENTS.md`](./AGENTS.md).

### Scripts

```bash
npm run dev         # next dev
npm run build       # next build
npm run start       # next start
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
```

---

## Roadmap

The trial v1 ships everything in the **Shipped** column of
[`ARCHITECTURE.md`](./ARCHITECTURE.md#whats-built-vs-whats-next). Highlights of
what's next:

| Phase | Focus | Examples |
|---|---|---|
| **Phase 1 (now)** | Intelligence layer | X breaking news in chat, server-side chat history, mobile voice polish |
| **Phase 2 (May–Jun)** | Analytics & screening | Stock screener (filter by signal combo), economic calendar, portfolio analytics, multi-portfolio |
| **Phase 3 (Jul–Aug)** | Market coverage | International stocks (ASX, LSE, HKEX), options chain, fixed-income analytics, on-chain crypto metrics |
| **Phase 4 (Q4)** | Platform | Brokerage integration (Plaid → Schwab/Fidelity/IBKR), drag-and-drop dashboard layouts, API access, backtesting |

---

## The Bloomberg comparison

| Dimension | Bloomberg Terminal | xBullRadar |
|---|---|---|
| **Price** | $24,000/yr/seat | ~$100/mo to run (infra) |
| **AI** | Bolted-on GPT wrapper | AI-native: Grok co-pilot, voice personas, portfolio-aware reasoning, voice rebalancing |
| **Social sentiment** | News wire + limited Twitter | Real-time X scoring via `x_search`, grounded in actual posts with citations |
| **Voice** | None | Built-in voice agent — ask, analyze, execute, hands-free |
| **Trading** | EMSX (institutional) | Ondo Finance (tokenized, on-chain, retail-accessible) |
| **Signals** | Raw data — user does the analysis | Pre-computed multi-signal verdicts: technical + fundamental + sentiment + ERP |
| **Deployment** | Dedicated hardware + network | Any browser, any device, Vercel edge |

The honest gap: Bloomberg has 40 years of data depth, microsecond-latency
exchange feeds, and the network effect of 350,000 terminal users on Bloomberg
MSG. We don't compete on those — we compete on **intelligence, accessibility,
cost, and the AI-native experience** that a 1980s architecture can't retrofit.

---

## License

Proprietary — © Cintelis. All rights reserved.

For investor inquiries, see the [pitch deck](https://app.xbullradar.com/investors/xBullRadar-Pitch-Deck.pdf)
or reach out to the team.
