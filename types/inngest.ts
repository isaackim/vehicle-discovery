/** Inngest event schemas — keep in sync with inngest/client.ts EventSchemas */

export type VehiclePayload = {
  year: number;
  make: string;
  model: string;
  engine?: string; // optional — e.g. "2JZ-GTE", "LS3"
  region: string;  // e.g. "Southern California"
};

export type Events = {
  // ── Trigger ──────────────────────────────────────────────────────────────
  "vehicle/scrape.requested": {
    data: VehiclePayload;
  };

  // ── Progress (frontend subscribes to these) ───────────────────────────────
  "vehicle/scrape.progress": {
    data: {
      runId: string;
      vehicle: VehiclePayload;
      stage: "started" | "agents" | "reddit" | "social" | "forums" | "dealers" | "search" | "scoring";
      agentsDone: number;
      agentsTotal: number;
      candidatesFound: number;
      message: string;
    };
  };

  // ── Completion ────────────────────────────────────────────────────────────
  "vehicle/scrape.completed": {
    data: {
      runId: string;
      vehicle: VehiclePayload;
      totalCandidates: number;
      greenLeads: number;
      durationMs: number;
    };
  };

  // ── Legacy / other ────────────────────────────────────────────────────────
  "agent/scrape.requested": {
    data: {
      triggeredBy: string;
      region?: string;
    };
  };
  "agent/lead.scored": {
    data: {
      leadId: string;
      vioScore: "green" | "yellow" | "red";
      confidence: number;
    };
  };
};
