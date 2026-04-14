-- =============================================================================
-- Dyno Lead Agent — Initial Schema
-- =============================================================================
-- Tables:  vehicles → jobs → leads
-- Cascade: deleting a vehicle cascades to jobs; deleting a job cascades to leads.
-- RLS:     disabled — all server access uses the service-role key.
-- =============================================================================

-- ─── Helper: updated_at trigger ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ─── vehicles ─────────────────────────────────────────────────────────────────
-- One row per unique vehicle search target (year + make + model + engine + region).
-- Scraping jobs reference this table rather than storing the target inline.

CREATE TABLE public.vehicles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  year        smallint    NOT NULL CHECK (year BETWEEN 1990 AND 2030),
  make        text        NOT NULL,
  model       text        NOT NULL,
  engine      text,                             -- NULL = "any engine for this model"
  region      text        NOT NULL DEFAULT 'Southern California',
  active      boolean     NOT NULL DEFAULT true, -- false = paused without deletion
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- NULL-safe unique index: two rows with engine=NULL are treated as the same target.
CREATE UNIQUE INDEX vehicles_target_uidx
  ON public.vehicles (year, lower(make), lower(model), COALESCE(lower(engine), ''), lower(region));

CREATE INDEX vehicles_active_idx ON public.vehicles (active) WHERE active = true;

COMMENT ON TABLE  public.vehicles         IS 'Vehicle search targets for the dyno lead-gen pipeline.';
COMMENT ON COLUMN public.vehicles.engine  IS 'Engine code/description; NULL means search any engine for this model.';
COMMENT ON COLUMN public.vehicles.active  IS 'Set false to pause scraping without deleting the vehicle record.';

CREATE TRIGGER vehicles_set_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vehicles DISABLE ROW LEVEL SECURITY;

-- ─── jobs ─────────────────────────────────────────────────────────────────────
-- One row per Inngest function invocation.
-- Created at job start; updated as the pipeline progresses.

CREATE TABLE public.jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       uuid        NOT NULL REFERENCES public.vehicles (id) ON DELETE RESTRICT,
  inngest_run_id   text        UNIQUE,           -- Inngest runId; NULL until first step fires
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  trigger          text        NOT NULL DEFAULT 'manual'
                               CHECK (trigger IN ('manual', 'cron')),
  total_candidates integer,                      -- raw candidate count before scoring
  hot_leads        integer,                      -- leads with vio_score >= 60
  error_log        jsonb,                        -- { agentName: errorMessage, ... }
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_vehicle_id_idx  ON public.jobs (vehicle_id);
CREATE INDEX jobs_status_idx      ON public.jobs (status) WHERE status IN ('pending', 'running');
CREATE INDEX jobs_created_at_idx  ON public.jobs (created_at DESC);
CREATE INDEX jobs_run_id_idx      ON public.jobs (inngest_run_id) WHERE inngest_run_id IS NOT NULL;

COMMENT ON TABLE  public.jobs                  IS 'Inngest scrape job instances — one per vehicle target per run.';
COMMENT ON COLUMN public.jobs.inngest_run_id   IS 'Inngest runId string; set after the first step executes.';
COMMENT ON COLUMN public.jobs.error_log        IS 'Per-agent non-fatal errors: { reddit: "message", ... }.';
COMMENT ON COLUMN public.jobs.total_candidates IS 'Raw signal count before Claude extraction.';
COMMENT ON COLUMN public.jobs.hot_leads        IS 'Leads with vio_score >= 60 after scoring.';

CREATE TRIGGER jobs_set_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;

-- ─── leads ────────────────────────────────────────────────────────────────────
-- One row per extracted, scored lead signal.
-- Deduped within a job on source_url; same URL can appear across different jobs.

CREATE TABLE public.leads (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid        NOT NULL REFERENCES public.jobs (id) ON DELETE CASCADE,
  run_id                text,                    -- Inngest runId (denormalized for quick lookup)

  -- ── Source ─────────────────────────────────────────────────────────────────
  source                text        NOT NULL
                                    CHECK (source IN ('reddit','social','forums','dealers','search')),
  source_url            text        NOT NULL,
  scraped_at            timestamptz NOT NULL,
  extracted_at          timestamptz NOT NULL,

  -- ── Person ─────────────────────────────────────────────────────────────────
  person_name           text,
  person_handle         text,
  contact_info          text,

  -- ── Vehicle (extracted from post text) ─────────────────────────────────────
  vehicle_year          smallint    CHECK (vehicle_year BETWEEN 1900 AND 2030),
  vehicle_make          text,
  vehicle_model         text,
  vehicle_engine        text,
  vehicle_mileage       integer     CHECK (vehicle_mileage >= 0),
  vehicle_color         text,
  vehicle_vin           char(17)    CHECK (vehicle_vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),

  -- ── Location ───────────────────────────────────────────────────────────────
  location_raw          text,                    -- as stated in the text
  location_city         text,
  location_state        char(2),
  location_zip          char(5)     CHECK (location_zip ~ '^\d{5}$'),
  soca_confirmed        boolean     NOT NULL DEFAULT false,

  -- ── Purchase recency ───────────────────────────────────────────────────────
  purchase_recency_days integer     CHECK (purchase_recency_days >= 0),
  purchase_phrase       text,
  post_age_hours        real,
  effective_age_days    real,       -- = post_age_days + purchase_recency_days

  -- ── Platform ───────────────────────────────────────────────────────────────
  platform              text        NOT NULL
                                    CHECK (platform IN ('reddit','social','forums','dealers','search')),
  platform_subsource    text,       -- subreddit name, forum slug, etc.

  -- ── Scoring ────────────────────────────────────────────────────────────────
  vio_score             smallint    NOT NULL DEFAULT 0 CHECK (vio_score BETWEEN 0 AND 100),
  vio_score_recency     smallint    NOT NULL DEFAULT 0 CHECK (vio_score_recency BETWEEN 0 AND 40),
  vio_score_region      smallint    NOT NULL DEFAULT 0 CHECK (vio_score_region BETWEEN 0 AND 35),
  vio_score_mileage     smallint    NOT NULL DEFAULT 0 CHECK (vio_score_mileage BETWEEN 0 AND 25),
  claude_confidence     real        NOT NULL DEFAULT 0 CHECK (claude_confidence BETWEEN 0.0 AND 1.0),

  -- ── Search context (denormalized from the parent job's vehicle target) ──────
  search_make           text        NOT NULL,
  search_model          text        NOT NULL,
  search_year           smallint    NOT NULL,
  search_engine         text,
  search_region         text        NOT NULL,

  -- ── Raw text ───────────────────────────────────────────────────────────────
  raw_text              text,                    -- truncated to 10 000 chars at write time

  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Dedup: same source URL is upserted within a job, but can recur across jobs
  UNIQUE (source_url, job_id)
);

-- Core access patterns
CREATE INDEX leads_job_id_idx       ON public.leads (job_id);
CREATE INDEX leads_vio_score_idx    ON public.leads (vio_score DESC);
CREATE INDEX leads_created_at_idx   ON public.leads (created_at DESC);
-- Filtered indexes for common dashboard queries
CREATE INDEX leads_hot_idx          ON public.leads (job_id, vio_score DESC) WHERE vio_score >= 60;
CREATE INDEX leads_soca_idx         ON public.leads (job_id) WHERE soca_confirmed = true;
CREATE INDEX leads_vehicle_idx      ON public.leads (vehicle_make, vehicle_model, vehicle_year);
CREATE INDEX leads_contact_idx      ON public.leads (job_id) WHERE contact_info IS NOT NULL;

COMMENT ON TABLE  public.leads                    IS 'Extracted and scored vehicle leads from all scraping agents.';
COMMENT ON COLUMN public.leads.vio_score          IS '0–100 composite: recency(40) + region_match(35) + mileage(25).';
COMMENT ON COLUMN public.leads.effective_age_days IS 'True purchase age = post_age_hours/24 + purchase_recency_days.';
COMMENT ON COLUMN public.leads.soca_confirmed     IS 'True when Claude confirmed an explicit SoCal location signal.';
COMMENT ON COLUMN public.leads.run_id             IS 'Inngest runId — denormalized from jobs.inngest_run_id for quick lookup.';
COMMENT ON COLUMN public.leads.raw_text           IS 'Truncated scraped text (max 10 000 chars).';

ALTER TABLE public.leads DISABLE ROW LEVEL SECURITY;
