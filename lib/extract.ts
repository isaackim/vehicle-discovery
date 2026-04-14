/**
 * Claude-powered extraction step.
 *
 * For each raw LeadCandidate produced by the scraping agents, this module:
 *   1. Calls Claude (Sonnet) via the tool-use API to extract structured fields.
 *   2. Calculates a 0–100 VIO score from three orthogonal components:
 *        • Recency    (0–40) — how recently the vehicle was purchased
 *        • RegionMatch (0–35) — strength of the Southern California signal
 *        • Mileage    (0–25) — proximity of odometer to the 15–1000 mi band
 *   3. Returns a typed Lead object ready for Supabase persistence.
 *
 * Prompt caching (cache_control: ephemeral) is applied to the system prompt
 * so repeated calls within a run share the cached prefix, cutting token cost.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LeadCandidate, Lead, VioScoreBreakdown } from "@/types/leads";
import type { VehiclePayload } from "@/types/inngest";
import { anthropic } from "@/lib/claude";

// ─── Tool definition ──────────────────────────────────────────────────────────

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_lead",
  description:
    "Extract every available lead signal from raw scraped text for a dyno-testing " +
    "vehicle recruitment campaign in Southern California.",
  input_schema: {
    type: "object",
    properties: {
      // Person
      person_name: {
        type: "string",
        description:
          "Full real name of the vehicle owner if explicitly stated (e.g. 'John Smith').",
      },
      person_handle: {
        type: "string",
        description:
          "Online username, Reddit handle, forum screen-name, or social media handle of the poster.",
      },
      contact_info: {
        type: "string",
        description:
          "Any contact information found: phone number, email address, DM link, or profile URL.",
      },

      // Vehicle
      vehicle_year: {
        type: "integer",
        description: "4-digit model year (e.g. 2023). Must be between 1990 and 2030.",
      },
      vehicle_make: {
        type: "string",
        description: "Manufacturer name, properly capitalised (e.g. 'Subaru', 'Toyota', 'Ford').",
      },
      vehicle_model: {
        type: "string",
        description:
          "Official model name (e.g. 'WRX', 'Supra', 'F-150'). Include trim suffix if mentioned.",
      },
      vehicle_engine: {
        type: "string",
        description:
          "Engine code or description if mentioned or clearly implied by trim " +
          "(e.g. 'FA24DIT', 'EJ257', 'LS3', '2JZ-GTE', 'Coyote 5.0'). " +
          "Infer from model/trim only when the mapping is unambiguous.",
      },
      vehicle_mileage: {
        type: "integer",
        description:
          "Current odometer reading in miles. Brand-new pickups are often 3–50 mi. " +
          "Must be a non-negative integer.",
      },
      vehicle_color: {
        type: "string",
        description: "Exterior colour if stated.",
      },
      vehicle_vin: {
        type: "string",
        description:
          "17-character VIN if present verbatim in the text. Do NOT guess or construct one.",
      },

      // Location
      location_raw: {
        type: "string",
        description:
          "Location exactly as stated in the text (e.g. 'the OC', 'San Diego area', 'Irvine, CA').",
      },
      location_city: {
        type: "string",
        description: "Resolved city name (e.g. 'Irvine', 'Los Angeles', 'San Diego').",
      },
      location_state: {
        type: "string",
        description: "2-letter US state code (e.g. 'CA', 'NV'). Omit if uncertain.",
      },
      location_zip: {
        type: "string",
        description: "5-digit ZIP code if present verbatim in the text.",
      },
      socat_confirmed: {
        type: "boolean",
        description:
          "true ONLY when the text explicitly places the vehicle or owner in Southern California — " +
          "defined as: Los Angeles County, Orange County, San Diego County, Riverside County, " +
          "San Bernardino County, or Ventura County. Set false if uncertain.",
      },

      // Purchase recency
      purchase_recency_days: {
        type: "integer",
        description:
          "Estimated days since the vehicle was purchased/delivered, measured from the date of posting. " +
          "'Just picked up' or 'took delivery today' → 0. " +
          "'Yesterday' → 1. 'Last week' → 7. 'A month ago' → 30. " +
          "Be conservative: when the phrase is vague (e.g. 'just'), use 2.",
      },
      purchase_phrase: {
        type: "string",
        description:
          "The exact phrase from the text that most strongly signals a recent purchase " +
          "(e.g. 'just picked up', 'took delivery yesterday', 'signed the papers on Friday').",
      },

      // Confidence
      confidence: {
        type: "number",
        description:
          "0.0–1.0 confidence that this is a real, unique, contactable lead for a dyno-testing " +
          "recruitment campaign in Southern California. " +
          "Reduce for: deleted/anonymous author, no SoCal signal, no vehicle details, " +
          "purchase >60 days ago, mileage >5000, or ambiguous text.",
      },
    },
    required: ["confidence"],
  },
};

// ─── Zod validation for tool output ──────────────────────────────────────────

const ToolOutputSchema = z.object({
  person_name: z.string().optional(),
  person_handle: z.string().optional(),
  contact_info: z.string().optional(),
  vehicle_year: z.number().int().min(1990).max(2030).optional(),
  vehicle_make: z.string().optional(),
  vehicle_model: z.string().optional(),
  vehicle_engine: z.string().optional(),
  vehicle_mileage: z.number().int().min(0).optional(),
  vehicle_color: z.string().optional(),
  vehicle_vin: z.string().length(17).optional().or(z.string().max(0).optional()),
  location_raw: z.string().optional(),
  location_city: z.string().optional(),
  location_state: z.string().max(2).toUpperCase().optional(),
  location_zip: z.string().regex(/^\d{5}$/).optional(),
  socat_confirmed: z.boolean().default(false),
  purchase_recency_days: z.number().int().min(0).optional(),
  purchase_phrase: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

type ToolOutput = z.infer<typeof ToolOutputSchema>;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a lead-extraction specialist for a dyno-testing vehicle recruitment service \
operating in Southern California.

Our goal: identify people who have recently (within 90 days) taken delivery of a \
low-mileage vehicle (ideally 15–1000 odometer miles) in the SoCal region \
(LA, OC, San Diego, Inland Empire, Ventura County) so we can invite them to a paid dyno test.

Rules:
• Extract only what is clearly stated or unambiguously implied — never fabricate values.
• For socat_confirmed, require explicit geographic evidence. Subreddit alone is not enough.
• For purchase_recency_days, measure from the POST date, not today.
• For vehicle_engine, only infer from trim when the mapping is industry-standard \
  (e.g. WRX → FA24DIT for 2022+, STI → EJ257, Supra 3.0 → B58).
• Set confidence < 0.3 when: no contact info, no SoCal signal, mileage > 5 000, \
  or purchase was more than 60 days before the post.`;

// ─── SoCal city reference set ─────────────────────────────────────────────────
// Used to upgrade region-match score when Claude resolves a specific city.

const SOCAL_CITIES = new Set([
  // LA County
  "los angeles","long beach","glendale","santa clarita","lancaster","palmdale",
  "pomona","torrance","burbank","pasadena","el monte","downey","inglewoodd",
  "west covina","norwalk","compton","carson","santa monica","beverly hills",
  "culver city","hawthorne","gardena","lakewood","bellflower","whittier",
  "monterey park","redondo beach","manhattan beach","hermosa beach","inglewood",
  "el segundo","lawndale","paramount","south gate","lynwood","maywood",
  "commerce","montebello","rosemead","temple city","arcadia","monrovia",
  "duarte","azusa","glendora","san dimas","la verne","claremont","upland",
  // OC
  "anaheim","santa ana","irvine","huntington beach","garden grove","orange",
  "fullerton","costa mesa","mission viejo","westminster","newport beach",
  "buena park","lake forest","tustin","yorba linda","laguna niguel","la habra",
  "fountain valley","aliso viejo","brea","placentia","cypress","stanton",
  "san clemente","dana point","laguna beach","laguna hills","laguna woods",
  "los alamitos","seal beach","villa park","rancho santa margarita",
  // SD County
  "san diego","chula vista","oceanside","escondido","el cajon","carlsbad",
  "vista","san marcos","encinitas","santee","la mesa","poway","lemon grove",
  "national city","santee","el cajon","lakeside","spring valley",
  // Riverside County
  "riverside","moreno valley","corona","murrieta","temecula","perris","menifee",
  "hemet","palm springs","indio","palm desert","cathedral city","coachella",
  "lake elsinore","norco","jurupa valley","beaumont","banning",
  // SB County
  "san bernardino","fontana","rancho cucamonga","ontario","victorville","rialto",
  "hesperia","chino","chino hills","colton","redlands","yucaipa","apple valley",
  "adelanto","barstow","twentynine palms","highland","loma linda",
  // Ventura County
  "oxnard","thousand oaks","simi valley","ventura","camarillo","moorpark",
  "fillmore","santa paula","port hueneme","ojai",
]);

// ─── VIO scoring ─────────────────────────────────────────────────────────────

/** Days since the post was published (float). Returns null if unknown. */
function computePostAgeHours(sourceCreatedAt?: string): number | null {
  if (!sourceCreatedAt) return null;
  const ms = Date.now() - new Date(sourceCreatedAt).getTime();
  return ms / (1000 * 60 * 60);
}

/**
 * True purchase age in days.
 * = days since post + days before post that the purchase happened.
 */
export function computeEffectiveAgeDays(
  postAgeHours: number | null,
  purchaseRecencyDays: number | null
): number | null {
  if (postAgeHours === null) return purchaseRecencyDays ?? null;
  const postAgeDays = postAgeHours / 24;
  return postAgeDays + (purchaseRecencyDays ?? 0);
}

/** Recency component (0–40). Decays with effective age. */
function scoreRecency(effectiveAgeDays: number | null): number {
  if (effectiveAgeDays === null) return 0; // unknown → no credit
  if (effectiveAgeDays <= 3)  return 40;
  if (effectiveAgeDays <= 7)  return 33;
  if (effectiveAgeDays <= 14) return 24;
  if (effectiveAgeDays <= 30) return 15;
  if (effectiveAgeDays <= 60) return 7;
  if (effectiveAgeDays <= 90) return 2;
  return 0;
}

/**
 * Region-match component (0–35).
 *
 * Hierarchy (highest wins, not additive):
 *   35 — Claude resolved a specific SoCal city
 *   30 — Claude set socat_confirmed + locationState = CA
 *   25 — Claude set socat_confirmed (state unknown)
 *   15 — Agent flagged SoCal (socaConfirmedByAgent) but Claude didn't confirm
 *    0 — No SoCal signal
 */
function scoreRegionMatch(
  extracted: ToolOutput,
  socaConfirmedByAgent: boolean
): number {
  if (
    extracted.location_city &&
    SOCAL_CITIES.has(extracted.location_city.toLowerCase())
  ) {
    return 35;
  }
  if (extracted.socat_confirmed && extracted.location_state === "CA") return 30;
  if (extracted.socat_confirmed) return 25;
  if (socaConfirmedByAgent) return 15;
  return 0;
}

/**
 * Mileage component (0–25).
 *
 * Band              Points   Rationale
 * 15–1 000 mi       25      VIO green — perfect target
 * 1–14 mi           18      Under-range but very fresh
 * 0 mi              12      Brand-new, pre-first-drive
 * 1 001–2 500 mi    10      Slightly over — still worth contacting
 * 2 501–5 000 mi     4      Borderline
 * > 5 000 mi         0      Out of range
 * unknown            8      Neutral — many valid posts omit mileage
 */
function scoreMileage(mileage: number | undefined): number {
  if (mileage === undefined || mileage === null) return 8;
  if (mileage >= 15 && mileage <= 1000)   return 25;
  if (mileage >= 1 && mileage < 15)       return 18;
  if (mileage === 0)                       return 12;
  if (mileage > 1000 && mileage <= 2500)  return 10;
  if (mileage > 2500 && mileage <= 5000)  return 4;
  return 0;
}

/** Assemble the full breakdown and integer total. */
export function scoreVio(
  extracted: ToolOutput,
  effectiveAgeDays: number | null,
  socaConfirmedByAgent: boolean
): VioScoreBreakdown {
  const recency     = scoreRecency(effectiveAgeDays);
  const regionMatch = scoreRegionMatch(extracted, socaConfirmedByAgent);
  const mileage     = scoreMileage(extracted.vehicle_mileage);
  return { recency, regionMatch, mileage, total: recency + regionMatch + mileage };
}

// ─── Claude call ──────────────────────────────────────────────────────────────

async function callClaude(
  rawText: string,
  vehicle: VehiclePayload
): Promise<ToolOutput> {
  const contextLine =
    `Target vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model}` +
    (vehicle.engine ? ` (${vehicle.engine})` : "") +
    ` in ${vehicle.region}.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    // Prompt caching — system prompt is identical across all calls in a batch,
    // so it's cached after the first call, saving ~90% of system-prompt tokens.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [EXTRACT_TOOL],
    // Force Claude to always call extract_lead — no prose fallback.
    tool_choice: { type: "tool", name: "extract_lead" },
    messages: [
      {
        role: "user",
        content:
          `${contextLine}\n\n` +
          `Extract all lead signals from the text below.\n\n` +
          `---\n${rawText.slice(0, 6000)}\n---`,
      },
    ],
  });

  // tool_choice: tool guarantees the first content block is a tool_use block.
  const block = response.content[0];
  if (block.type !== "tool_use") {
    throw new Error(
      `Claude returned "${block.type}" instead of tool_use. ` +
        `Stop reason: ${response.stop_reason}`
    );
  }

  const parsed = ToolOutputSchema.safeParse(block.input);
  if (!parsed.success) {
    throw new Error(
      `Tool output failed schema validation: ${parsed.error.message}\n` +
        `Raw input: ${JSON.stringify(block.input)}`
    );
  }

  return parsed.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExtractionContext {
  vehicle: VehiclePayload;
  /** True when the scraping agent already confirmed a SoCal location signal */
  socaConfirmedByAgent?: boolean;
}

/**
 * Extract a single LeadCandidate into a fully-scored Lead.
 *
 * Throws on Claude API errors — callers should catch and handle gracefully
 * (e.g. fall back to a zero-scored placeholder).
 */
export async function extractLead(
  candidate: LeadCandidate,
  ctx: ExtractionContext
): Promise<Lead> {
  const postAgeHours     = computePostAgeHours(candidate.sourceCreatedAt);
  const extracted        = await callClaude(candidate.rawText, ctx.vehicle);
  const effectiveAgeDays = computeEffectiveAgeDays(
    postAgeHours,
    extracted.purchase_recency_days ?? null
  );
  const breakdown = scoreVio(
    extracted,
    effectiveAgeDays,
    ctx.socaConfirmedByAgent ?? false
  );

  return {
    // Identity
    id: crypto.randomUUID(),
    source: candidate.source,
    sourceUrl: candidate.sourceUrl,
    scrapedAt: candidate.scrapedAt,
    extractedAt: new Date().toISOString(),

    // Person
    personName:   extracted.person_name   ?? null,
    personHandle: extracted.person_handle ?? null,
    contactInfo:  extracted.contact_info  ?? null,

    // Vehicle
    vehicleYear:    extracted.vehicle_year    ?? candidate.year    ?? null,
    vehicleMake:    extracted.vehicle_make    ?? candidate.make    ?? null,
    vehicleModel:   extracted.vehicle_model   ?? candidate.model   ?? null,
    vehicleEngine:  extracted.vehicle_engine  ?? null,
    vehicleMileage: extracted.vehicle_mileage ?? candidate.mileage ?? null,
    vehicleColor:   extracted.vehicle_color   ?? null,
    vehicleVin:     extracted.vehicle_vin     ?? null,

    // Location
    locationRaw:   extracted.location_raw   ?? candidate.location ?? null,
    locationCity:  extracted.location_city  ?? null,
    locationState: extracted.location_state ?? null,
    locationZip:   extracted.location_zip   ?? null,
    socaConfirmed: extracted.socat_confirmed,

    // Purchase recency
    purchaseRecencyDays: extracted.purchase_recency_days ?? null,
    purchasePhrase:      extracted.purchase_phrase       ?? null,
    postAgeHours,
    effectiveAgeDays,

    // Platform
    platform:          candidate.source,
    platformSubsource: candidate.platformSubsource ?? null,

    // Scoring
    vioScore:          breakdown.total,
    vioScoreBreakdown: breakdown,
    claudeConfidence:  extracted.confidence,

    // Raw
    rawText: candidate.rawText,
  };
}

/**
 * Extract an array of candidates concurrently, up to `concurrency` at a time.
 * Failed extractions are replaced with a zero-scored placeholder rather than
 * propagating the error — one bad API call shouldn't drop the whole batch.
 */
export async function extractLeads(
  candidates: LeadCandidate[],
  ctx: ExtractionContext,
  { concurrency = 5 }: { concurrency?: number } = {}
): Promise<Lead[]> {
  const leads: Lead[] = [];

  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch   = candidates.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((c) => extractLead(c, ctx))
    );

    for (let j = 0; j < settled.length; j++) {
      const result = settled[j];
      if (result.status === "fulfilled") {
        leads.push(result.value);
      } else {
        const candidate = batch[j];
        console.error(
          `[extract] Failed for ${candidate.sourceUrl}: ${result.reason}`
        );
        // Zero-scored placeholder so the lead isn't silently dropped
        leads.push(zeroLead(candidate));
      }
    }
  }

  return leads;
}

/** Placeholder lead used when Claude extraction fails for a single candidate. */
function zeroLead(candidate: LeadCandidate): Lead {
  return {
    id: crypto.randomUUID(),
    source: candidate.source,
    sourceUrl: candidate.sourceUrl,
    scrapedAt: candidate.scrapedAt,
    extractedAt: new Date().toISOString(),
    personName: null,
    personHandle: null,
    contactInfo: candidate.contactInfo ?? null,
    vehicleYear: candidate.year ?? null,
    vehicleMake: candidate.make ?? null,
    vehicleModel: candidate.model ?? null,
    vehicleEngine: null,
    vehicleMileage: candidate.mileage ?? null,
    vehicleColor: null,
    vehicleVin: null,
    locationRaw: candidate.location ?? null,
    locationCity: null,
    locationState: null,
    locationZip: null,
    socaConfirmed: false,
    purchaseRecencyDays: null,
    purchasePhrase: null,
    postAgeHours: computePostAgeHours(candidate.sourceCreatedAt),
    effectiveAgeDays: null,
    platform: candidate.source,
    platformSubsource: candidate.platformSubsource ?? null,
    vioScore: 0,
    vioScoreBreakdown: { recency: 0, regionMatch: 0, mileage: 0, total: 0 },
    claudeConfidence: 0,
    rawText: candidate.rawText,
  };
}
