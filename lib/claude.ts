import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { VehiclePayload } from "@/types/inngest";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// ─── Schema ───────────────────────────────────────────────────────────────────

const ExtractionSchema = z.object({
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().min(1900).max(2030).optional(),
  mileage: z.number().min(0).optional(),
  location: z.string().optional(),
  contactInfo: z.string().optional(),
  /** 0–1: how confident Claude is that this is a real, contactable lead */
  confidence: z.number().min(0).max(1),
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

// ─── Extraction ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a vehicle lead extraction assistant for a dyno testing recruitment service.
Your job is to extract structured data from scraped web text about vehicles for sale or available in Southern California.

Respond with ONLY a JSON object — no markdown, no explanation.
Required field: confidence (0.0–1.0, how likely this is a real contactable lead).
All other fields are optional — only include them if the text clearly states them.

JSON shape:
{
  "make": string,
  "model": string,
  "year": number,
  "mileage": number,          // odometer miles (integers only)
  "location": string,         // city, neighborhood, or zip code
  "contactInfo": string,      // phone, email, username, or URL
  "confidence": number        // required
}`;

/**
 * Extract structured lead data from raw scraped text using Claude.
 * Accepts optional vehicle context to improve extraction accuracy.
 *
 * Throws if the Claude response is unparseable — callers should handle this.
 */
export async function extractAndScoreLead(
  rawText: string,
  vehicleContext?: VehiclePayload
): Promise<ExtractionResult> {
  const contextHint = vehicleContext
    ? `\n\nSearch context (the vehicle we are looking for): ${vehicleContext.year} ${vehicleContext.make} ${vehicleContext.model}${vehicleContext.engine ? ` (${vehicleContext.engine})` : ""} in ${vehicleContext.region}.`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract vehicle lead data from the following text.${contextHint}\n\nText:\n${rawText.slice(0, 4000)}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected Claude response type: ${block.type}`);
  }

  // Strip accidental markdown fences before parsing
  const json = block.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const parsed = ExtractionSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(`Claude extraction schema mismatch: ${parsed.error.message}`);
  }

  return parsed.data;
}

/**
 * Legacy single-field extractor — kept for backward compatibility.
 * Prefer `extractAndScoreLead` for new code.
 */
export async function extractLeadData(rawText: string) {
  return extractAndScoreLead(rawText);
}
