export type AgentSource = "reddit" | "social" | "forums" | "dealers" | "search";

export interface LeadCandidate {
  source: AgentSource;
  sourceUrl: string;
  rawText: string;
  scrapedAt: string;          // ISO — when we fetched it
  sourceCreatedAt?: string;   // ISO — when the original post was published
  platformSubsource?: string; // subreddit name, forum slug, etc.
  // Pre-extraction hints from the agent (not authoritative — Claude decides)
  make?: string;
  model?: string;
  year?: number;
  mileage?: number;
  location?: string;
  contactInfo?: string;
}

/** Categorical alias kept for graph backward-compat */
export type VioScore = "green" | "yellow" | "red";

/** @deprecated — use Lead + vioScore (0-100 integer) instead */
export interface ScoredLead extends LeadCandidate {
  vioScore: VioScore;
  confidence: number;
  extractedAt?: string;
}

// ─── Scored output types ──────────────────────────────────────────────────────

/** Score breakdown powering the 0–100 VIO integer. */
export interface VioScoreBreakdown {
  /** 0–40: recency of purchase. Decays with effective age in days. */
  recency: number;
  /** 0–35: strength of Southern California location signal. */
  regionMatch: number;
  /** 0–25: proximity of odometer reading to the 15–1000 mi green range. */
  mileage: number;
  /** Sum of the three components. */
  total: number;
}

/** Fully-extracted, scored lead — the final pipeline output. */
export interface Lead {
  // ── Identity ─────────────────────────────────────────────────────────────
  id: string;            // uuid generated at extraction time
  runId?: string;
  source: AgentSource;
  sourceUrl: string;
  scrapedAt: string;
  extractedAt: string;

  // ── Person ────────────────────────────────────────────────────────────────
  personName: string | null;    // real name if present
  personHandle: string | null;  // username / Reddit handle
  contactInfo: string | null;   // phone, email, DM link, profile URL

  // ── Vehicle ───────────────────────────────────────────────────────────────
  vehicleYear: number | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleEngine: string | null;  // e.g. "FA24DIT", "2JZ-GTE"
  vehicleMileage: number | null;
  vehicleColor: string | null;
  vehicleVin: string | null;

  // ── Location ──────────────────────────────────────────────────────────────
  locationRaw: string | null;    // as stated ("the OC", "Irvine, CA")
  locationCity: string | null;
  locationState: string | null;  // 2-letter code
  locationZip: string | null;
  socaConfirmed: boolean;

  // ── Purchase recency ──────────────────────────────────────────────────────
  /** Days since purchase as stated in the post (relative to post date) */
  purchaseRecencyDays: number | null;
  /** Exact phrase that indicated a recent purchase */
  purchasePhrase: string | null;
  /** Hours between post creation and now — null if sourceCreatedAt unknown */
  postAgeHours: number | null;
  /** True purchase age = postAgeDays + purchaseRecencyDays */
  effectiveAgeDays: number | null;

  // ── Platform ──────────────────────────────────────────────────────────────
  platform: AgentSource;
  platformSubsource: string | null; // subreddit, forum slug, etc.

  // ── Scoring ───────────────────────────────────────────────────────────────
  vioScore: number;                    // 0–100
  vioScoreBreakdown: VioScoreBreakdown;
  claudeConfidence: number;            // 0–1

  // ── Raw ───────────────────────────────────────────────────────────────────
  rawText: string;
}
