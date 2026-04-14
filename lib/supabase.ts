/**
 * Typed Supabase client + DB helper functions.
 *
 * All server-side access (API routes, Inngest functions, LangGraph nodes)
 * uses the service-role client exported here — it bypasses RLS and must
 * never be imported in browser/client components.
 *
 * For client components, create a browser client with the public anon key:
 *   import { createClient } from "@supabase/supabase-js";
 *   const browser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
 */

import { createClient } from "@supabase/supabase-js";
import type { Lead } from "@/types/leads";
import type { VehiclePayload } from "@/types/inngest";

// ─── Database type definitions ────────────────────────────────────────────────
// Manually maintained; replace with `supabase gen types typescript` output
// once you have a linked Supabase project.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type AgentSourceCol = "reddit" | "social" | "forums" | "dealers" | "search";
export type JobStatus      = "pending" | "running" | "completed" | "failed";
export type JobTrigger     = "manual" | "cron";

// ── vehicles ──────────────────────────────────────────────────────────────────

export interface VehicleRow {
  id:         string;
  year:       number;
  make:       string;
  model:      string;
  engine:     string | null;
  region:     string;
  active:     boolean;
  created_at: string;
  updated_at: string;
}

export interface VehicleInsert {
  id?:         string;
  year:        number;
  make:        string;
  model:       string;
  engine?:     string | null;
  region?:     string;
  active?:     boolean;
  created_at?: string;
  updated_at?: string;
}

export type VehicleUpdate = Partial<VehicleInsert>;

// ── jobs ──────────────────────────────────────────────────────────────────────

export interface JobRow {
  id:               string;
  vehicle_id:       string;
  inngest_run_id:   string | null;
  status:           JobStatus;
  trigger:          JobTrigger;
  total_candidates: number | null;
  hot_leads:        number | null;
  error_log:        Record<string, string> | null;
  started_at:       string | null;
  completed_at:     string | null;
  created_at:       string;
  updated_at:       string;
}

export interface JobInsert {
  id?:               string;
  vehicle_id:        string;
  inngest_run_id?:   string | null;
  status?:           JobStatus;
  trigger?:          JobTrigger;
  total_candidates?: number | null;
  hot_leads?:        number | null;
  error_log?:        Record<string, string> | null;
  started_at?:       string | null;
  completed_at?:     string | null;
  created_at?:       string;
  updated_at?:       string;
}

export type JobUpdate = Partial<JobInsert>;

// ── leads ─────────────────────────────────────────────────────────────────────

export interface LeadRow {
  id:                    string;
  job_id:                string;
  run_id:                string | null;
  source:                AgentSourceCol;
  source_url:            string;
  scraped_at:            string;
  extracted_at:          string;
  person_name:           string | null;
  person_handle:         string | null;
  contact_info:          string | null;
  vehicle_year:          number | null;
  vehicle_make:          string | null;
  vehicle_model:         string | null;
  vehicle_engine:        string | null;
  vehicle_mileage:       number | null;
  vehicle_color:         string | null;
  vehicle_vin:           string | null;
  location_raw:          string | null;
  location_city:         string | null;
  location_state:        string | null;
  location_zip:          string | null;
  soca_confirmed:        boolean;
  purchase_recency_days: number | null;
  purchase_phrase:       string | null;
  post_age_hours:        number | null;
  effective_age_days:    number | null;
  platform:              AgentSourceCol;
  platform_subsource:    string | null;
  vio_score:             number;
  vio_score_recency:     number;
  vio_score_region:      number;
  vio_score_mileage:     number;
  claude_confidence:     number;
  search_make:           string;
  search_model:          string;
  search_year:           number;
  search_engine:         string | null;
  search_region:         string;
  raw_text:              string | null;
  created_at:            string;
}

export interface LeadInsert {
  id?:                    string;
  job_id:                 string;
  run_id?:                string | null;
  source:                 AgentSourceCol;
  source_url:             string;
  scraped_at:             string;
  extracted_at:           string;
  person_name?:           string | null;
  person_handle?:         string | null;
  contact_info?:          string | null;
  vehicle_year?:          number | null;
  vehicle_make?:          string | null;
  vehicle_model?:         string | null;
  vehicle_engine?:        string | null;
  vehicle_mileage?:       number | null;
  vehicle_color?:         string | null;
  vehicle_vin?:           string | null;
  location_raw?:          string | null;
  location_city?:         string | null;
  location_state?:        string | null;
  location_zip?:          string | null;
  soca_confirmed?:        boolean;
  purchase_recency_days?: number | null;
  purchase_phrase?:       string | null;
  post_age_hours?:        number | null;
  effective_age_days?:    number | null;
  platform:               AgentSourceCol;
  platform_subsource?:    string | null;
  vio_score?:             number;
  vio_score_recency?:     number;
  vio_score_region?:      number;
  vio_score_mileage?:     number;
  claude_confidence?:     number;
  search_make:            string;
  search_model:           string;
  search_year:            number;
  search_engine?:         string | null;
  search_region:          string;
  raw_text?:              string | null;
  created_at?:            string;
}

export type LeadUpdate = Partial<LeadInsert>;

// ── Database root ─────────────────────────────────────────────────────────────

export type Database = {
  public: {
    Tables: {
      vehicles: { Row: VehicleRow; Insert: VehicleInsert; Update: VehicleUpdate };
      jobs:     { Row: JobRow;     Insert: JobInsert;     Update: JobUpdate     };
      leads:    { Row: LeadRow;    Insert: LeadInsert;    Update: LeadUpdate    };
    };
    Views:          Record<string, never>;
    Functions:      Record<string, never>;
    Enums:          Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

// ─── Client ───────────────────────────────────────────────────────────────────

/** Server-side client (service role). Never import this in client components. */
export const supabase = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── vehicles helpers ─────────────────────────────────────────────────────────

/**
 * Find or create a vehicle row for the given search target.
 * Uses a select-then-insert pattern to handle the NULL-safe unique index
 * (`COALESCE(lower(engine), '')`), which can't be expressed with the JS
 * upsert API's `onConflict` string parameter.
 *
 * @returns The vehicle's UUID.
 */
export async function upsertVehicle(payload: VehiclePayload): Promise<string> {
  // Build a case-insensitive match — mirrors the unique index expressions.
  let query = supabase
    .from("vehicles")
    .select("id")
    .eq("year", payload.year)
    .ilike("make", payload.make)
    .ilike("model", payload.model)
    .ilike("region", payload.region);

  if (payload.engine) {
    query = query.ilike("engine", payload.engine);
  } else {
    query = query.is("engine", null);
  }

  const { data: existing, error: selectErr } = await query.maybeSingle();
  if (selectErr) throw new Error(`upsertVehicle select failed: ${selectErr.message}`);
  if (existing) return existing.id;

  const { data: created, error: insertErr } = await supabase
    .from("vehicles")
    .insert({
      year:   payload.year,
      make:   payload.make,
      model:  payload.model,
      engine: payload.engine ?? null,
      region: payload.region,
    })
    .select("id")
    .single();

  if (insertErr) {
    // 23505 = unique_violation — a concurrent request beat us; retry the select.
    if (insertErr.code === "23505") {
      const { data: retry } = await query.single();
      if (retry) return retry.id;
    }
    throw new Error(`upsertVehicle insert failed: ${insertErr.message}`);
  }

  return created.id;
}

// ─── jobs helpers ─────────────────────────────────────────────────────────────

/**
 * Create a new job row linked to a vehicle.
 * Call this before invoking the LangGraph pipeline so the job ID can be
 * threaded through the graph state and attached to every lead row.
 *
 * @returns The new job's UUID.
 */
export async function createJob(opts: {
  vehicleId:     string;
  inngestRunId?: string;
  trigger:       JobTrigger;
}): Promise<string> {
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      vehicle_id:     opts.vehicleId,
      inngest_run_id: opts.inngestRunId ?? null,
      status:         "pending",
      trigger:        opts.trigger,
      started_at:     new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data.id;
}

/**
 * Update mutable fields on a job (status, counts, timestamps, error log).
 * Partial — only provided fields are written.
 */
export async function updateJob(jobId: string, update: JobUpdate): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update(update)
    .eq("id", jobId);

  if (error) throw new Error(`updateJob failed: ${error.message}`);
}

// ─── leads helpers ────────────────────────────────────────────────────────────

/**
 * Map a Lead domain object + job context to a LeadInsert DB row.
 * Internal — used by writeLeads.
 */
function leadToInsert(lead: Lead, jobId: string, vehicle: VehiclePayload): LeadInsert {
  return {
    // Identifiers
    id:       lead.id,
    job_id:   jobId,
    run_id:   lead.runId ?? null,

    // Source
    source:       lead.source,
    source_url:   lead.sourceUrl,
    scraped_at:   lead.scrapedAt,
    extracted_at: lead.extractedAt,

    // Person
    person_name:   lead.personName,
    person_handle: lead.personHandle,
    contact_info:  lead.contactInfo,

    // Vehicle
    vehicle_year:    lead.vehicleYear,
    vehicle_make:    lead.vehicleMake,
    vehicle_model:   lead.vehicleModel,
    vehicle_engine:  lead.vehicleEngine,
    vehicle_mileage: lead.vehicleMileage,
    vehicle_color:   lead.vehicleColor,
    vehicle_vin:     lead.vehicleVin,

    // Location
    location_raw:   lead.locationRaw,
    location_city:  lead.locationCity,
    location_state: lead.locationState,
    location_zip:   lead.locationZip,
    soca_confirmed: lead.socaConfirmed,

    // Purchase recency
    purchase_recency_days: lead.purchaseRecencyDays,
    purchase_phrase:       lead.purchasePhrase,
    post_age_hours:        lead.postAgeHours,
    effective_age_days:    lead.effectiveAgeDays,

    // Platform
    platform:           lead.platform,
    platform_subsource: lead.platformSubsource,

    // Scoring
    vio_score:         lead.vioScore,
    vio_score_recency: lead.vioScoreBreakdown.recency,
    vio_score_region:  lead.vioScoreBreakdown.regionMatch,
    vio_score_mileage: lead.vioScoreBreakdown.mileage,
    claude_confidence: lead.claudeConfidence,

    // Search context (denormalized from the vehicle target)
    search_make:   vehicle.make,
    search_model:  vehicle.model,
    search_year:   vehicle.year,
    search_engine: vehicle.engine ?? null,
    search_region: vehicle.region,

    // Raw text — truncated to stay within Supabase text field limits
    raw_text: lead.rawText.slice(0, 10_000),
  };
}

/**
 * Upsert an array of Lead objects into the leads table, linked to a job.
 *
 * Conflict resolution: `(source_url, job_id)` — the same URL can be scraped
 * by multiple agents in the same run, but is only written once per job.
 * Re-running the same job updates existing rows rather than creating duplicates.
 *
 * Inserts in batches of 100 to avoid Supabase request size limits.
 *
 * @param leads    - Scored Lead objects from lib/extract.ts
 * @param jobId    - UUID of the parent jobs row (created via createJob)
 * @param vehicle  - Vehicle payload used for the search_* denormalized columns
 * @returns        Array of persisted lead UUIDs (in insertion order)
 */
export async function writeLeads(
  leads:   Lead[],
  jobId:   string,
  vehicle: VehiclePayload
): Promise<string[]> {
  if (leads.length === 0) return [];

  const rows = leads.map((l) => leadToInsert(l, jobId, vehicle));
  const persistedIds: string[] = [];
  const BATCH = 100;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    const { data, error } = await supabase
      .from("leads")
      .upsert(batch, {
        onConflict:        "source_url,job_id",
        ignoreDuplicates:  false, // update existing rows on conflict
      })
      .select("id");

    if (error) {
      throw new Error(
        `writeLeads upsert failed (batch ${i}–${i + batch.length}): ${error.message}`
      );
    }

    for (const row of data ?? []) persistedIds.push(row.id);
  }

  return persistedIds;
}
