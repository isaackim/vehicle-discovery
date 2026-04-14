import { Inngest, EventSchemas } from "inngest";
import type { Events } from "@/types/inngest";

export const inngest = new Inngest({
  id: "dyno-lead-agent",
  name: "Dyno Lead Agent",
  schemas: new EventSchemas().fromRecord<Events>(),
});
