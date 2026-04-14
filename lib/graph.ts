/**
 * LangGraph vehicle-scraping pipeline
 *
 * Flow:
 *   validate_input
 *       │
 *       ▼  (conditional fan-out via Send)
 *   ┌───┴──────────────────────────────────────────┐
 *   │         │          │          │              │
 * agent_    agent_    agent_    agent_         agent_
 * reddit    social    forums    dealers        search
 *   │         │          │          │              │
 *   └───┬──────────────────────────────────────────┘
 *       │  (join — waits for all 5 to complete)
 *       ▼
 *  claude_extraction   ← NLP extraction + VIO scoring per candidate
 *       │
 *       ▼
 *  supabase_write      ← upsert scored leads, return persisted IDs
 *       │
 *       ▼
 *     END
 */

import { Annotation, StateGraph, Send, END } from "@langchain/langgraph";
import { writeLeads } from "@/lib/supabase";
import { extractLeads } from "@/lib/extract";
import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate, Lead } from "@/types/leads";
import { runRedditAgent } from "@/agents/redditAgent";
import { runSocialAgent } from "@/agents/socialAgent";
import { runForumsAgent } from "@/agents/forumsAgent";
import { runDealersAgent } from "@/agents/dealersAgent";
import { runSearchAgent } from "@/agents/searchAgent";

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Typed state channels for the vehicle-scraping graph.
 *
 * Key design choices:
 * - `candidates`  uses a concat reducer so parallel agent nodes can each
 *   append their results without clobbering each other.
 * - `agentErrors` uses a merge reducer so each failing agent can record
 *   its error independently.
 * - All other channels use last-write-wins (default reducer).
 */
export const GraphState = Annotation.Root({
  // ── Input ──────────────────────────────────────────────────────────────────
  vehicle: Annotation<VehiclePayload>({
    reducer: (_, incoming) => incoming,
  }),
  runId: Annotation<string>({
    reducer: (_, incoming) => incoming,
  }),
  /** UUID of the jobs table row — required for writeLeads; set by the caller. */
  jobId: Annotation<string | undefined>({
    reducer: (_, incoming) => incoming,
    default: () => undefined,
  }),

  // ── Parallel agent outputs (merge via reducer) ─────────────────────────────
  candidates: Annotation<LeadCandidate[]>({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),

  // ── Per-agent error log (non-fatal — failed agents are skipped) ────────────
  agentErrors: Annotation<Record<string, string>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),

  // ── Claude extraction output ───────────────────────────────────────────────
  leads: Annotation<Lead[]>({
    reducer: (_, incoming) => incoming,
    default: () => [],
  }),

  // ── Supabase write output ──────────────────────────────────────────────────
  persistedIds: Annotation<string[]>({
    reducer: (_, incoming) => incoming,
    default: () => [],
  }),
});

/** TypeScript type derived from the Annotation definition. */
export type GraphStateType = typeof GraphState.State;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Run a Promise-returning agent fn, catching errors so one agent can't abort the whole graph. */
async function safeRun<T>(
  label: string,
  fn: () => Promise<T[]>
): Promise<{ results: T[]; error?: string }> {
  try {
    return { results: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[graph] ${label} failed:`, message);
    return { results: [], error: message };
  }
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

/** Validates the input vehicle payload and sets a runId if missing. */
async function validateInput(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { vehicle, runId } = state;

  if (!vehicle?.make || !vehicle?.model || !vehicle?.year || !vehicle?.region) {
    throw new Error(
      `Invalid vehicle payload: ${JSON.stringify(vehicle)}. Required: make, model, year, region.`
    );
  }

  return {
    runId: runId ?? crypto.randomUUID(),
    vehicle,
  };
}

/**
 * Fan-out router: dispatches one Send per agent node so all five run in
 * parallel. Each Send passes the full current state as the node's input.
 */
function fanOut(
  state: GraphStateType
): Send[] {
  const nodes = [
    "agent_reddit",
    "agent_social",
    "agent_forums",
    "agent_dealers",
    "agent_search",
  ] as const;

  return nodes.map((node) => new Send(node, state));
}

// ── Individual agent nodes ────────────────────────────────────────────────────

async function agentReddit(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { results, error } = await safeRun("reddit", () => runRedditAgent(state.vehicle));
  return {
    candidates: results,
    ...(error ? { agentErrors: { reddit: error } } : {}),
  };
}

async function agentSocial(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { results, error } = await safeRun("social", () => runSocialAgent(state.vehicle));
  return {
    candidates: results,
    ...(error ? { agentErrors: { social: error } } : {}),
  };
}

async function agentForums(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { results, error } = await safeRun("forums", () => runForumsAgent(state.vehicle));
  return {
    candidates: results,
    ...(error ? { agentErrors: { forums: error } } : {}),
  };
}

async function agentDealers(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { results, error } = await safeRun("dealers", () => runDealersAgent(state.vehicle));
  return {
    candidates: results,
    ...(error ? { agentErrors: { dealers: error } } : {}),
  };
}

async function agentSearch(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { results, error } = await safeRun("search", () => runSearchAgent(state.vehicle));
  return {
    candidates: results,
    ...(error ? { agentErrors: { search: error } } : {}),
  };
}

/**
 * Claude extraction node — join point after all 5 agents.
 *
 * Calls lib/extract.extractLeads which:
 *   • uses the tool-use API for structured output
 *   • computes a 0–100 VIO score (recency + region + mileage)
 *   • falls back to a zero-scored placeholder on per-candidate failures
 */
async function claudeExtraction(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { candidates, vehicle } = state;

  if (candidates.length === 0) {
    console.warn("[graph] claude_extraction: no candidates to score");
    return { leads: [] };
  }

  const leads = await extractLeads(
    candidates,
    { vehicle },
    { concurrency: 5 }
  );

  return { leads };
}

/**
 * Supabase write node — upserts all scored leads.
 *
 * Uses `source_url` as the conflict key so re-runs don't create duplicates.
 * Maps the full Lead shape to snake_case DB columns.
 */
async function supabaseWrite(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { leads, vehicle, jobId } = state;

  if (leads.length === 0) return { persistedIds: [] };

  if (!jobId) {
    // jobId is required to link leads to a job row. If not provided (e.g. in
    // tests or direct runVehicleGraph calls without a pre-created job), skip
    // the write and log a warning rather than throwing — the leads are still
    // available in state for the caller to handle.
    console.warn("[graph] supabase_write: no jobId in state — skipping DB write");
    return { persistedIds: [] };
  }

  const persistedIds = await writeLeads(leads, jobId, vehicle);
  return { persistedIds };
}

// ─── Graph assembly ───────────────────────────────────────────────────────────

export function buildVehicleGraph() {
  const graph = new StateGraph(GraphState);

  // Nodes
  graph.addNode("validate_input", validateInput);
  graph.addNode("agent_reddit", agentReddit);
  graph.addNode("agent_social", agentSocial);
  graph.addNode("agent_forums", agentForums);
  graph.addNode("agent_dealers", agentDealers);
  graph.addNode("agent_search", agentSearch);
  graph.addNode("claude_extraction", claudeExtraction);
  graph.addNode("supabase_write", supabaseWrite);

  // Entry → validate
  graph.addEdge("__start__", "validate_input");

  // Validate → parallel fan-out via Send
  graph.addConditionalEdges("validate_input", fanOut, [
    "agent_reddit",
    "agent_social",
    "agent_forums",
    "agent_dealers",
    "agent_search",
  ]);

  // All agents → join at claude_extraction (LangGraph waits for all 5)
  graph.addEdge(
    ["agent_reddit", "agent_social", "agent_forums", "agent_dealers", "agent_search"],
    "claude_extraction"
  );

  // claude_extraction → supabase_write → END
  graph.addEdge("claude_extraction", "supabase_write");
  graph.addEdge("supabase_write", END);

  return graph.compile();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RunVehicleGraphResult {
  runId: string;
  totalCandidates: number;
  leads: Lead[];
  /** Leads with vioScore >= 60 — strong SoCal + recency + mileage signal */
  hotLeads: number;
  persistedIds: string[];
  agentErrors: Record<string, string>;
}

/**
 * Convenience wrapper — builds, compiles, and runs the graph for a single
 * vehicle payload. Returns a structured summary.
 */
export async function runVehicleGraph(
  vehicle: VehiclePayload,
  runId?: string,
  jobId?: string
): Promise<RunVehicleGraphResult> {
  const app = buildVehicleGraph();

  const finalState: GraphStateType = await app.invoke({
    vehicle,
    runId: runId ?? crypto.randomUUID(),
    jobId,
  });

  return {
    runId: finalState.runId,
    totalCandidates: finalState.candidates.length,
    leads: finalState.leads,
    hotLeads: finalState.leads.filter((l) => l.vioScore >= 60).length,
    persistedIds: finalState.persistedIds,
    agentErrors: finalState.agentErrors,
  };
}
