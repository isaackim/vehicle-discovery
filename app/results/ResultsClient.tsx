"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import useSWR from "swr";
import type { LeadRow } from "@/lib/supabase";
import type { LeadsApiResponse } from "@/app/api/leads/route";

// ─── Types ────────────────────────────────────────────────────────────────────

type SortCol = "vio_score" | "name" | "vehicle" | "region" | "source" | "created_at";
type SortDir = "asc" | "desc";

const PRESETS = [
  { label: "All",    min: 0,  max: 100 },
  { label: "40+",    min: 40, max: 100 },
  { label: "Hot 60+",min: 60, max: 100 },
  { label: "Best 80+",min: 80, max: 100 },
] as const;

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function useRelativeClock(iso: string | null): string {
  const [label, setLabel] = useState("—");
  useEffect(() => {
    if (!iso) return;
    const tick = () => setLabel(relativeTime(iso));
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [iso]);
  return label;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const fetcher = (url: string): Promise<LeadsApiResponse> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function relativeTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)   return "just now";
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function vehicleLabel(l: LeadRow): string {
  const parts = [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean);
  return parts.length ? parts.join(" ") : "—";
}

function nameLabel(l: LeadRow): string {
  return l.person_name ?? (l.person_handle ? `@${l.person_handle}` : null) ?? "—";
}

function regionLabel(l: LeadRow): string {
  if (l.location_city && l.location_state) return `${l.location_city}, ${l.location_state}`;
  if (l.location_city)  return l.location_city;
  if (l.location_raw)   return l.location_raw;
  return "—";
}

function sourceLabel(l: LeadRow): string {
  const base = l.platform.charAt(0).toUpperCase() + l.platform.slice(1);
  return l.platform_subsource ? `${base} · r/${l.platform_subsource}` : base;
}

function scoreColors(score: number) {
  if (score >= 80) return { badge: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-600/30", bar: "bg-emerald-500" };
  if (score >= 60) return { badge: "bg-green-100 text-green-800 ring-1 ring-green-600/30",       bar: "bg-green-500"   };
  if (score >= 40) return { badge: "bg-amber-100 text-amber-800 ring-1 ring-amber-600/30",        bar: "bg-amber-400"   };
  return             { badge: "bg-red-100 text-red-800 ring-1 ring-red-500/30",                   bar: "bg-red-400"     };
}

function sortLeads(leads: LeadRow[], col: SortCol, dir: SortDir): LeadRow[] {
  return [...leads].sort((a, b) => {
    let va: string | number, vb: string | number;
    switch (col) {
      case "name":       va = nameLabel(a);     vb = nameLabel(b);     break;
      case "vehicle":    va = vehicleLabel(a);  vb = vehicleLabel(b);  break;
      case "region":     va = regionLabel(a);   vb = regionLabel(b);   break;
      case "source":     va = sourceLabel(a);   vb = sourceLabel(b);   break;
      case "created_at": va = a.created_at;     vb = b.created_at;     break;
      default:           va = a.vio_score;      vb = b.vio_score;      break;
    }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1  : -1;
    return 0;
  });
}

function exportCsv(leads: LeadRow[]): void {
  const cols = [
    ["Name/Handle",         (l: LeadRow) => l.person_name ?? l.person_handle ?? ""],
    ["Vehicle",             (l: LeadRow) => vehicleLabel(l)],
    ["Engine",              (l: LeadRow) => l.vehicle_engine ?? ""],
    ["Mileage",             (l: LeadRow) => l.vehicle_mileage ?? ""],
    ["City",                (l: LeadRow) => l.location_city ?? ""],
    ["State",               (l: LeadRow) => l.location_state ?? ""],
    ["SoCal Confirmed",     (l: LeadRow) => l.soca_confirmed ? "Yes" : "No"],
    ["VIO Score",           (l: LeadRow) => l.vio_score],
    ["Score · Recency",     (l: LeadRow) => l.vio_score_recency],
    ["Score · Region",      (l: LeadRow) => l.vio_score_region],
    ["Score · Mileage",     (l: LeadRow) => l.vio_score_mileage],
    ["Claude Confidence",   (l: LeadRow) => l.claude_confidence],
    ["Platform",            (l: LeadRow) => l.platform],
    ["Subsource",           (l: LeadRow) => l.platform_subsource ?? ""],
    ["Source URL",          (l: LeadRow) => l.source_url],
    ["Contact Info",        (l: LeadRow) => l.contact_info ?? ""],
    ["Purchase Phrase",     (l: LeadRow) => l.purchase_phrase ?? ""],
    ["Effective Age (days)",(l: LeadRow) => l.effective_age_days ?? ""],
    ["Found At",            (l: LeadRow) => l.created_at],
  ] as const;

  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header  = cols.map(([name]) => escape(name)).join(",");
  const body    = leads.map((l) => cols.map(([, fn]) => escape(fn(l))).join(","));
  const csv     = [header, ...body].join("\n");

  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `dyno-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const { badge, bar } = scoreColors(score);
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums ${badge}`}>
        {score}
      </span>
      {/* Mini breakdown bar */}
      <div className="h-1 w-12 rounded-full bg-gray-200">
        <div className={`h-1 rounded-full ${bar}`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function SortHeader({
  col, label, current, dir, onSort,
}: {
  col: SortCol; label: string; current: SortCol; dir: SortDir;
  onSort: (col: SortCol) => void;
}) {
  const active = col === current;
  return (
    <th
      scope="col"
      onClick={() => onSort(col)}
      className="cursor-pointer select-none whitespace-nowrap px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? "text-gray-900" : "text-gray-300"}`}>
          {active ? (dir === "desc" ? "▼" : "▲") : "⇅"}
        </span>
      </span>
    </th>
  );
}

function LiveIndicator({ isValidating }: { isValidating: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          isValidating ? "animate-pulse bg-amber-400" : "bg-emerald-400"
        }`}
      />
      {isValidating ? "Refreshing…" : "Live"}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ResultsClient() {
  const [minScore,  setMinScore]  = useState(0);
  const [maxScore,  setMaxScore]  = useState(100);
  const [sortCol,   setSortCol]   = useState<SortCol>("vio_score");
  const [sortDir,   setSortDir]   = useState<SortDir>("desc");
  const [activePreset, setActivePreset] = useState(0); // index into PRESETS

  const dMin = useDebounce(minScore, 400);
  const dMax = useDebounce(maxScore, 400);

  const swrKey = `/api/leads?min_score=${dMin}&max_score=${dMax}&limit=500`;

  const { data, error, isValidating } = useSWR<LeadsApiResponse>(swrKey, fetcher, {
    refreshInterval:  10_000,
    revalidateOnFocus: true,
    dedupingInterval:  5_000,
    keepPreviousData:  true,   // show stale data while revalidating — no flash
  });

  const updatedAgo = useRelativeClock(data?.fetchedAt ?? null);

  // Apply client-side sort to already-fetched data
  const sorted = useMemo(
    () => (data?.leads ? sortLeads(data.leads, sortCol, sortDir) : []),
    [data?.leads, sortCol, sortDir]
  );

  // Stats derived from full (unsorted) lead set
  const stats = useMemo(() => {
    const leads = data?.leads ?? [];
    return {
      total:          leads.length,
      socaCount:      leads.filter((l) => l.soca_confirmed).length,
      contactCount:   leads.filter((l) => l.contact_info).length,
      avgScore:       leads.length
        ? Math.round(leads.reduce((s, l) => s + l.vio_score, 0) / leads.length)
        : 0,
    };
  }, [data?.leads]);

  const handleSort = useCallback((col: SortCol) => {
    setSortCol((prev) => {
      if (prev === col) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
      else              setSortDir("desc");
      return col;
    });
  }, []);

  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
    setMinScore(p.min);
    setMaxScore(p.max);
    setActivePreset(idx);
  };

  // Keep active preset indicator in sync when inputs are changed manually
  useEffect(() => {
    const match = PRESETS.findIndex((p) => p.min === minScore && p.max === maxScore);
    setActivePreset(match);
  }, [minScore, maxScore]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="mx-auto max-w-screen-xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Dyno Lead Results</h1>
              <p className="mt-0.5 text-sm text-gray-500">
                {data
                  ? `${stats.total} lead${stats.total !== 1 ? "s" : ""} · updated ${updatedAgo}`
                  : isValidating
                  ? "Loading…"
                  : error
                  ? "Failed to load"
                  : "—"}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <LiveIndicator isValidating={isValidating} />
              <button
                onClick={() => exportCsv(sorted)}
                disabled={sorted.length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {/* Down-arrow icon (inline SVG — no icon library needed) */}
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2a.75.75 0 0 1 .75.75v6.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06L7.25 9.44V2.75A.75.75 0 0 1 8 2ZM2.75 13.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z" />
                </svg>
                Export CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-screen-xl px-6 py-4">
        {/* ── Filter bar ───────────────────────────────────────────────────── */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            VIO Score
          </span>

          {/* Preset pills */}
          <div className="flex gap-1.5">
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                onClick={() => applyPreset(i)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  activePreset === i
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-400">Range</span>
            {/* Min input */}
            <input
              type="number"
              min={0}
              max={maxScore}
              value={minScore}
              onChange={(e) => {
                const v = Math.min(Number(e.target.value), maxScore);
                setMinScore(Math.max(0, v));
              }}
              className="w-16 rounded-md border border-gray-300 px-2 py-1 text-center text-sm tabular-nums focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
            {/* Visual range track */}
            <div className="relative h-1.5 w-32 rounded-full bg-gray-200">
              <div
                className="absolute h-1.5 rounded-full bg-gray-900"
                style={{
                  left:  `${minScore}%`,
                  width: `${maxScore - minScore}%`,
                }}
              />
            </div>
            {/* Max input */}
            <input
              type="number"
              min={minScore}
              max={100}
              value={maxScore}
              onChange={(e) => {
                const v = Math.max(Number(e.target.value), minScore);
                setMaxScore(Math.min(100, v));
              }}
              className="w-16 rounded-md border border-gray-300 px-2 py-1 text-center text-sm tabular-nums focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          </div>
        </div>

        {/* ── Stats row ─────────────────────────────────────────────────────── */}
        {data && (
          <div className="mb-4 flex flex-wrap gap-4">
            {[
              { label: "Total leads",    value: stats.total },
              { label: "SoCal confirmed",value: stats.socaCount },
              { label: "Have contact",   value: stats.contactCount },
              { label: "Avg VIO score",  value: stats.avgScore },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Error state ───────────────────────────────────────────────────── */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Failed to load leads: {error.message}. Retrying every 10 seconds.
          </div>
        )}

        {/* ── Empty state ───────────────────────────────────────────────────── */}
        {!error && !isValidating && sorted.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white py-16 text-center">
            <p className="text-sm text-gray-500">No leads match the current score filter.</p>
            <button
              onClick={() => applyPreset(0)}
              className="mt-2 text-sm font-medium text-gray-900 underline underline-offset-2"
            >
              Show all
            </button>
          </div>
        )}

        {/* ── Table ─────────────────────────────────────────────────────────── */}
        {sorted.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <SortHeader col="name"       label="Name / Handle" current={sortCol} dir={sortDir} onSort={handleSort} />
                    <SortHeader col="vehicle"    label="Vehicle"        current={sortCol} dir={sortDir} onSort={handleSort} />
                    <SortHeader col="region"     label="Region"         current={sortCol} dir={sortDir} onSort={handleSort} />
                    <SortHeader col="vio_score"  label="VIO Score"      current={sortCol} dir={sortDir} onSort={handleSort} />
                    <SortHeader col="source"     label="Source"         current={sortCol} dir={sortDir} onSort={handleSort} />
                    <SortHeader col="created_at" label="Found"          current={sortCol} dir={sortDir} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sorted.map((lead, i) => (
                    <LeadRow key={lead.id} lead={lead} index={i} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Table footer */}
            <div className="border-t border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-400">
              Showing {sorted.length} of {data?.total ?? "?"} lead{(data?.total ?? 0) !== 1 ? "s" : ""}
              {dMin > 0 || dMax < 100 ? ` · score ${dMin}–${dMax}` : ""}
              {" · "}Polling every 10 s
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Row component ────────────────────────────────────────────────────────────

function LeadRow({ lead, index }: { lead: LeadRow; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const { badge } = scoreColors(lead.vio_score);

  const vehicle = vehicleLabel(lead);
  const mileage = lead.vehicle_mileage != null ? `${lead.vehicle_mileage.toLocaleString()} mi` : null;
  const engine  = lead.vehicle_engine ?? null;

  const region       = regionLabel(lead);
  const socaChip = lead.soca_confirmed ? (
    <span className="ml-1 inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-700/20">
      SoCal ✓
    </span>
  ) : null;

  return (
    <>
      <tr
        className={`cursor-pointer transition-colors hover:bg-gray-50 ${index % 2 === 0 ? "" : "bg-gray-50/40"}`}
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Name / Handle */}
        <td className="px-3 py-3">
          <div className="flex items-center gap-2">
            <div>
              <p className="font-medium text-gray-900 text-sm">{nameLabel(lead)}</p>
              {lead.contact_info && (
                <p className="mt-0.5 max-w-[180px] truncate text-xs text-gray-500">
                  {lead.contact_info}
                </p>
              )}
            </div>
          </div>
        </td>

        {/* Vehicle */}
        <td className="px-3 py-3">
          <p className="text-sm font-medium text-gray-900">{vehicle}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            {[engine, mileage].filter(Boolean).join(" · ") || "—"}
          </p>
        </td>

        {/* Region */}
        <td className="px-3 py-3">
          <span className="text-sm text-gray-700">{region}</span>
          {socaChip}
        </td>

        {/* VIO Score */}
        <td className="px-3 py-3 text-center">
          <ScoreBadge score={lead.vio_score} />
        </td>

        {/* Source */}
        <td className="px-3 py-3">
          <a
            href={lead.source_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm text-gray-700 hover:text-gray-900 hover:underline"
          >
            {sourceLabel(lead)}
          </a>
        </td>

        {/* Found At */}
        <td className="px-3 py-3">
          <RelativeTime iso={lead.created_at} />
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className="bg-blue-50/30">
          <td colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
              <Detail label="Purchase phrase"  value={lead.purchase_phrase} />
              <Detail label="Recency days"     value={lead.purchase_recency_days} />
              <Detail label="Effective age"    value={lead.effective_age_days != null ? `${lead.effective_age_days.toFixed(1)} days` : null} />
              <Detail label="VIN"              value={lead.vehicle_vin} />
              <Detail label="Score breakdown"  value={`R:${lead.vio_score_recency} + G:${lead.vio_score_region} + M:${lead.vio_score_mileage} = ${lead.vio_score}`} />
              <Detail label="Claude confidence"value={lead.claude_confidence != null ? `${(lead.claude_confidence * 100).toFixed(0)}%` : null} />
              <Detail label="ZIP"              value={lead.location_zip} />
              <Detail label="Run ID"           value={lead.run_id} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div>
      <span className="text-gray-400">{label}: </span>
      <span className="text-gray-700">{String(value)}</span>
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  const label = useRelativeClock(iso);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="text-sm text-gray-500">
      {label}
    </time>
  );
}
