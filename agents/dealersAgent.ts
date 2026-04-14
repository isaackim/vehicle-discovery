/**
 * Dealers agent — web-scrapes SoCal dealership inventory pages
 * for vehicles in the 15–1000 mile VIO "green" range.
 */

import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate } from "@/types/leads";

export async function runDealersAgent(_vehicle: VehiclePayload): Promise<LeadCandidate[]> {
  // TODO: implement dealership scraping logic
  return [];
}
