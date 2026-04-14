# Dyno Lead Agent

A vehicle lead generation platform for dyno testing recruitment. It scrapes Reddit, Facebook Marketplace, Instagram, forums, and dealerships for recently purchased vehicles in Southern California, then uses Claude to extract and score each lead with a transparent VIO (Vehicle In Operation) scoring model.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Data Flow](#data-flow)
- [Folder Structure](#folder-structure)
- [VIO Scoring](#vio-scoring)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [Agent Status](#agent-status)

---

## Architecture Overview

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 + Tailwind CSS + shadcn/ui |
| Job queue | Inngest (durable jobs + daily cron) |
| Orchestration | LangGraph (parallel agent fan-out) |
| Agents | Reddit (snoowrap), Social (Apify), Forums (Playwright), Dealers (scrape), Search (Tavily) |
| AI extraction | Claude API (`claude-sonnet-4-6`) — NLP extraction + VIO scoring |
| Database | Supabase (Postgres) |
| Target region | Southern California (LA, OC, SD, Inland Empire, Ventura) |
| Vehicle criteria | 15–1000 miles (VIO "green" range) |

---

## Data Flow

```
Trigger (manual event or daily cron at 06:00 UTC)
    │
    ▼
Inngest: scrapeVehicleFunction
    ├── Upsert vehicle row (idempotent)
    ├── Create job row
    └── Run LangGraph pipeline
            │
            ▼
        validate_input
            │
     ┌──────┼──────┐──────────┬──────────┐
     ▼      ▼      ▼          ▼          ▼
  Reddit  Social Forums    Dealers    Search
  agent   agent  agent     agent      agent
     └──────┴──────┘──────────┴──────────┘
                        │
                        ▼
              claude_extraction
              (5 concurrent calls)
                        │
                        ▼
               supabase_write
               (upsert by source_url + job_id)
```

Each agent runs in parallel. Agent failures are isolated — one failure does not abort the pipeline. Claude scores each candidate with a 0–100 VIO score, and results are upserted to Supabase with deduplication.

Inngest emits progress events at three stages (`started → agents → scoring`) and a final `vehicle/scrape.completed` event, which the frontend can subscribe to for live updates.

---

## Folder Structure

```
code/
├── agents/                  # Scraping agents
│   ├── reddit.ts            # Reddit scraper (snoowrap)
│   ├── redditAgent.ts       # Reddit → LeadCandidate adapter
│   ├── social.ts            # Apify social media scraper
│   ├── socialAgent.ts       # Social → LeadCandidate adapter
│   ├── forumsAgent.ts       # Playwright forums scraper (TODO)
│   ├── dealersAgent.ts      # Dealership scraper (TODO)
│   └── searchAgent.ts       # Tavily web search (TODO)
│
├── app/                     # Next.js app directory
│   ├── api/
│   │   ├── inngest/route.ts # Inngest webhook handler
│   │   └── leads/route.ts   # GET /api/leads
│   ├── results/
│   │   ├── page.tsx         # Results page (server)
│   │   └── ResultsClient.tsx
│   ├── layout.tsx
│   └── page.tsx
│
├── inngest/                 # Job queue
│   ├── client.ts            # Inngest client
│   ├── functions.ts         # Function registry
│   └── scrapeVehicle.ts     # Main function (5 retries, daily cron)
│
├── lib/                     # Core business logic
│   ├── graph.ts             # LangGraph pipeline
│   ├── extract.ts           # Claude extraction + VIO scoring
│   ├── claude.ts            # Anthropic SDK setup
│   ├── supabase.ts          # DB client + helpers
│   └── utils.ts
│
├── types/                   # TypeScript interfaces
│   ├── leads.ts             # LeadCandidate, Lead, VioScoreBreakdown
│   ├── inngest.ts           # Event schemas
│   ├── reddit.ts            # RedditSignal
│   └── social.ts            # FacebookMarketplaceListing, InstagramPost
│
└── supabase/
    └── migrations/
        └── 20260410000000_initial_schema.sql
```

### Database Schema

Three tables with cascading deletes:

- **`vehicles`** — Unique scrape targets identified by year + make + model + engine + region
- **`jobs`** — Inngest run instances linked to a vehicle; status: `pending | running | completed | failed`
- **`leads`** — Extracted and scored candidates; deduplicated by `(source_url, job_id)`

---

## VIO Scoring

Each lead receives a transparent 0–100 score broken into three components:

| Component | Max | Criteria |
|---|---|---|
| Recency | 40 | Days since purchase: ≤3d = 40, ≤7d = 33, ≤14d = 24, ≤30d = 15, ≤60d = 7, ≤90d = 2, >90d = 0 |
| Region match | 35 | SoCal confirmation (LA/OC/SD/Inland Empire/Ventura) + city resolution bonus |
| Mileage | 25 | 15–1000 mi = 25 (perfect), <15 mi = 18, 0 mi = 12, 1001–2500 mi = 15, unknown = 5 |

Scores ≥ 60 are considered "hot" leads. The breakdown is stored in Supabase and visible to users.

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values.

```bash
# Anthropic
ANTHROPIC_API_KEY=

# Inngest
INNGEST_SIGNING_KEY=
INNGEST_EVENT_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Reddit (OAuth app credentials)
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=
REDDIT_USER_AGENT=

# Apify (Facebook Marketplace + Instagram)
APIFY_API_TOKEN=

# Tavily (web search — used by Search agent when implemented)
TAVILY_API_KEY=

# Next.js
NEXTAUTH_URL=http://localhost:3000
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project with the schema applied
- Inngest account (or run the dev server locally)
- Reddit OAuth app
- Apify account with Facebook/Instagram actors configured

### Install dependencies

```bash
npm install
```

### Apply database migrations

```bash
npx supabase db push
# or run the SQL in supabase/migrations/ directly in the Supabase dashboard
```

### Run locally

```bash
# Terminal 1 — Next.js dev server
npm run dev

# Terminal 2 — Inngest dev server (job queue)
npm run inngest:dev
```

The app runs at `http://localhost:3000`. The Inngest dev UI is at `http://localhost:8288`.

### Trigger a scrape manually

Send an event to Inngest:

```bash
curl -X POST http://localhost:8288/e/vehicle/scrape.requested \
  -H "Content-Type: application/json" \
  -d '{"name":"vehicle/scrape.requested","data":{"year":2024,"make":"Subaru","model":"WRX","region":"Southern California"}}'
```

Or use the Inngest dev UI to send the event interactively.

### Cron schedule

The default vehicle is scraped automatically every day at **06:00 UTC** via Inngest's built-in cron. Edit `inngest/scrapeVehicle.ts` to change the target or schedule.

---

## API Reference

### `GET /api/leads`

Query scored leads stored in Supabase.

| Param | Type | Default | Description |
|---|---|---|---|
| `min_score` | number | 0 | Minimum VIO score |
| `max_score` | number | 100 | Maximum VIO score |
| `limit` | number | 50 | Max results (cap: 500) |
| `offset` | number | 0 | Pagination offset |

**Response**

```json
{
  "leads": [...],
  "total": 142,
  "fetchedAt": "2026-04-13T06:00:00Z"
}
```

### `POST /api/inngest`

Inngest webhook handler. Do not call this directly — use the Inngest SDK or dev UI to send events.

---

## Agent Status

| Agent | Source | Status |
|---|---|---|
| Reddit | r/cars, r/askcarsales, r/socal, r/LosAngeles, r/sandiego, etc. | Implemented |
| Social | Facebook Marketplace + Instagram via Apify | Implemented |
| Forums | NASIOC, MotoIQ, Corvette Forum (Playwright) | TODO |
| Dealers | SoCal dealership inventory scrape | TODO |
| Search | Tavily API broad web search | TODO |

The pipeline is fault-tolerant — unimplemented agents return empty arrays and do not block the other agents or the Claude extraction step.
