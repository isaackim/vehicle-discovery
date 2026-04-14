This is the Dyno Lead Agent — a vehicle lead generation platform for
dyno testing recruitment. The stack is:
- Frontend: Next.js + Tailwind + shadcn/ui, deployed on Vercel
- Job queue: Inngest (durable jobs + cron scheduling)
- Orchestration: LangGraph (parallel agent fan-out)
- Agents: Reddit (PRAW), Social (Apify), Forums (Playwright),
  Dealers (web scrape), Search (Tavily API)
- AI extraction: Claude API (Sonnet) for NLP lead extraction + VIO scoring
- Database: Supabase (Postgres)
- Target region: Southern California
- Vehicle criteria: 15–1000 miles (VIO "green" range)

Document the folder structure, key env vars needed, and the data flow.