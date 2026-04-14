import { scrapeVehicleFunction } from "./scrapeVehicle";

// All functions exported here are registered at /api/inngest
export const functions = [
  scrapeVehicleFunction,
];
