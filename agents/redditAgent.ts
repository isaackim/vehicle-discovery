/**
 * Adapts RedditSignal objects from agents/reddit.ts into the canonical
 * LeadCandidate shape consumed by the LangGraph pipeline.
 */

import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate } from "@/types/leads";
import type { RedditSignal } from "@/types/reddit";
import { scrapeReddit } from "./reddit";

function signalToCandidate(signal: RedditSignal): LeadCandidate {
  return {
    source: "reddit",
    sourceUrl: signal.postUrl,
    // Feed title + body together so Claude has the full text for extraction
    rawText: [signal.title, signal.body].filter(Boolean).join("\n\n"),
    scrapedAt: new Date().toISOString(),
  };
}

export async function runRedditAgent(vehicle: VehiclePayload): Promise<LeadCandidate[]> {
  const signals = await scrapeReddit(vehicle);
  return signals.map(signalToCandidate);
}
