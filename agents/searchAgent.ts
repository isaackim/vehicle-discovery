/**
 * Search agent — uses Tavily API for broad web search queries
 * targeting low-mileage vehicle listings in Southern California.
 */

import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate } from "@/types/leads";

export async function runSearchAgent(_vehicle: VehiclePayload): Promise<LeadCandidate[]> {
  // TODO: implement Tavily search calls
  return [];
}
