import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import type { VehiclePayload } from "@/types/inngest";
import { upsertVehicle, createJob, updateJob } from "@/lib/supabase";
import { runVehicleGraph } from "@/lib/graph";

// Default vehicle target used when the function is woken by the cron trigger
// rather than a manual event (no payload available from the scheduler).
const CRON_DEFAULT: VehiclePayload = {
  year: new Date().getFullYear(),
  make: "Any",
  model: "Any",
  region: "Southern California",
};

const AGENTS_TOTAL = 5;

export const scrapeVehicleFunction = inngest.createFunction(
  {
    id: "scrape-vehicle-leads",
    name: "Scrape Vehicle Leads",

    // ── Retry / backoff ──────────────────────────────────────────────────────
    // Inngest retries each failing step with exponential backoff automatically.
    // retries: N means up to N attempts per step (attempt 1 + N-1 retries).
    // Backoff schedule (approximate): 10s → 30s → 2m → 10m → 30m
    retries: 5,

    // ── Concurrency ──────────────────────────────────────────────────────────
    // Cap parallel runs so we don't hammer external services simultaneously.
    concurrency: {
      limit: 3,
    },

    // ── Rate limit ───────────────────────────────────────────────────────────
    // At most 20 new runs per hour across all triggers.
    rateLimit: {
      limit: 20,
      period: "1h",
    },
  },

  // ── Triggers ───────────────────────────────────────────────────────────────
  // Accepts BOTH:
  //   • an explicit event  →  POST /api/inngest with { name: "vehicle/scrape.requested", data: { ... } }
  //   • a cron schedule    →  fires every day at 06:00 UTC
  [
    { event: "vehicle/scrape.requested" },
    { cron: "0 6 * * *" },
  ],

  async ({ event, step, runId, logger }) => {
    const startedAt = Date.now();

    // Resolve vehicle payload: event trigger carries data, cron trigger does not.
    const vehicle: VehiclePayload =
      event.name === "vehicle/scrape.requested" && event.data
        ? event.data
        : CRON_DEFAULT;

    const trigger = event.name === "vehicle/scrape.requested" ? "manual" : "cron";

    const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model, vehicle.engine]
      .filter(Boolean)
      .join(" ");

    logger.info(`[scrape-vehicle] Starting run for: ${vehicleLabel} in ${vehicle.region}`);

    // ── Step 1: Upsert vehicle row ────────────────────────────────────────────
    // Idempotent — finds existing or creates a new vehicle record.
    const vehicleId = await step.run("upsert-vehicle", async () => {
      try {
        return await upsertVehicle(vehicle);
      } catch (err) {
        // DB connection failure is transient; permanent schema errors are not.
        if (err instanceof Error && err.message.includes("does not exist")) {
          throw new NonRetriableError("Supabase table missing — run migrations", { cause: err });
        }
        throw err;
      }
    });

    // ── Step 2: Create job row ────────────────────────────────────────────────
    // One job row per Inngest run — links all leads back to this invocation.
    const jobId = await step.run("create-job", async () => {
      return createJob({
        vehicleId,
        inngestRunId: runId,
        trigger,
      });
    });

    logger.info(`[scrape-vehicle] job_id=${jobId} vehicle_id=${vehicleId}`);

    // ── Stage: started ────────────────────────────────────────────────────────
    await step.sendEvent("progress-started", {
      name: "vehicle/scrape.progress",
      data: {
        runId,
        vehicle,
        stage: "started",
        agentsDone: 0,
        agentsTotal: AGENTS_TOTAL,
        candidatesFound: 0,
        message: `Scrape started for ${vehicleLabel}`,
      },
    });

    // ── Step 3: Mark job as running ───────────────────────────────────────────
    await step.run("mark-running", () =>
      updateJob(jobId, { status: "running" })
    );

    // ── Stage: scoring ────────────────────────────────────────────────────────
    await step.sendEvent("progress-agents", {
      name: "vehicle/scrape.progress",
      data: {
        runId,
        vehicle,
        stage: "agents",
        agentsDone: 0,
        agentsTotal: AGENTS_TOTAL,
        candidatesFound: 0,
        message: `Running ${AGENTS_TOTAL} agents in parallel…`,
      },
    });

    // ── Step 4: Run LangGraph pipeline ────────────────────────────────────────
    // The graph fans out to all 5 agents in parallel, joins at Claude extraction,
    // scores every candidate, and upserts the results to Supabase — all within
    // this single step. If it throws, Inngest retries the whole graph run.
    const result = await step.run("run-graph", async () => {
      try {
        return await runVehicleGraph(vehicle, runId, jobId);
      } catch (err) {
        if (err instanceof Error && err.message.includes("401")) {
          throw new NonRetriableError(
            "Invalid Anthropic API key — check ANTHROPIC_API_KEY",
            { cause: err }
          );
        }
        throw err; // transient → Inngest retries with exponential backoff
      }
    });

    const { totalCandidates, leads, hotLeads, agentErrors } = result;

    // ── Stage: scoring complete ───────────────────────────────────────────────
    await step.sendEvent("progress-scoring", {
      name: "vehicle/scrape.progress",
      data: {
        runId,
        vehicle,
        stage: "scoring",
        agentsDone: AGENTS_TOTAL,
        agentsTotal: AGENTS_TOTAL,
        candidatesFound: totalCandidates,
        message: `Scored ${leads.length} leads (${hotLeads} hot ≥60)`,
      },
    });

    // ── Step 5: Mark job completed ────────────────────────────────────────────
    const hasErrors = Object.keys(agentErrors).length > 0;

    await step.run("complete-job", () =>
      updateJob(jobId, {
        status:           "completed",
        total_candidates: totalCandidates,
        hot_leads:        hotLeads,
        error_log:        hasErrors ? agentErrors : null,
        completed_at:     new Date().toISOString(),
      })
    );

    // ── Completion event ──────────────────────────────────────────────────────
    await step.sendEvent("completed", {
      name: "vehicle/scrape.completed",
      data: {
        runId,
        vehicle,
        totalCandidates,
        greenLeads: hotLeads,
        durationMs: Date.now() - startedAt,
      },
    });

    logger.info(
      `[scrape-vehicle] Done. ${hotLeads} hot leads / ${leads.length} total leads / ` +
      `${totalCandidates} candidates in ${Date.now() - startedAt}ms`
    );

    return {
      runId,
      jobId,
      vehicle,
      totalCandidates,
      totalLeads:  leads.length,
      hotLeads,
      agentErrors,
      durationMs: Date.now() - startedAt,
    };
  }
);
