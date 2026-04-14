import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { LeadRow } from "@/lib/supabase";

export const runtime = "nodejs";
// Disable Next.js response cache — leads must always be fresh
export const dynamic = "force-dynamic";

export interface LeadsApiResponse {
  leads: LeadRow[];
  total: number;
  fetchedAt: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const minScore = Math.max(0,   Math.min(100, Number(searchParams.get("min_score") ?? 0)));
  const maxScore = Math.max(0,   Math.min(100, Number(searchParams.get("max_score") ?? 100)));
  const limit    = Math.max(1,   Math.min(500, Number(searchParams.get("limit")     ?? 500)));
  const offset   = Math.max(0,                 Number(searchParams.get("offset")    ?? 0));

  const { data, error, count } = await supabase
    .from("leads")
    .select("*", { count: "exact" })
    .gte("vio_score", minScore)
    .lte("vio_score", maxScore)
    .order("vio_score",   { ascending: false })
    .order("created_at",  { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    leads:     data ?? [],
    total:     count ?? 0,
    fetchedAt: new Date().toISOString(),
  } satisfies LeadsApiResponse);
}
