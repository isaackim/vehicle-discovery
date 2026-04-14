/**
 * Forums agent — Playwright-based scraper targeting dyno / enthusiast
 * forums (NASIOC, MotoIQ, Corvette Forum, etc.).
 */

import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate } from "@/types/leads";

export async function runForumsAgent(_vehicle: VehiclePayload): Promise<LeadCandidate[]> {
  // TODO: implement Playwright scraping logic
  return [];
}
