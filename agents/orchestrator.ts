/**
 * Thin wrapper kept for Inngest backward-compatibility.
 * All orchestration logic lives in lib/graph.ts.
 */

import { runVehicleGraph } from "@/lib/graph";
import type { VehiclePayload } from "@/types/inngest";
import type { Lead } from "@/types/leads";

/** @deprecated Use runVehicleGraph() directly for new call sites. */
export async function runOrchestrator(
  vehicle?: VehiclePayload,
  runId?: string
): Promise<Lead[]> {
  const payload: VehiclePayload = vehicle ?? {
    year: new Date().getFullYear(),
    make: "Any",
    model: "Any",
    region: "Southern California",
  };

  const result = await runVehicleGraph(payload, runId);
  return result.leads;
}
