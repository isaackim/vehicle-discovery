/**
 * Social media agent — scrapes Facebook Marketplace listings and Instagram
 * posts via Apify actors. Returns purchase-intent signals for recently
 * acquired low-mileage vehicles in Southern California.
 *
 * FB Marketplace: searches vehicle listings by make/model in SoCal cities;
 *   filters to low-mileage listings whose description contains a purchase phrase.
 *
 * Instagram: searches vehicle-specific hashtags; filters to posts whose
 *   caption/location/bio contains SoCal signals and a purchase phrase.
 *
 * Both sources run in parallel and are deduplicated before returning.
 */

import { ApifyClient } from "apify-client";
import type { VehiclePayload } from "@/types/inngest";
import type { FacebookMarketplaceListing, InstagramPost } from "@/types/social";

// ─── Actor IDs ────────────────────────────────────────────────────────────────

/**
 * Apify actor for Facebook Marketplace vehicle listings.
 * https://apify.com/apify/facebook-marketplace-scraper
 */
const FB_ACTOR_ID = "apify/facebook-marketplace-scraper";

/**
 * Apify actor for Instagram posts by hashtag.
 * https://apify.com/apify/instagram-hashtag-scraper
 */
const IG_ACTOR_ID = "apify/instagram-hashtag-scraper";

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Max listings per FB location query */
const FB_MAX_ITEMS = 100;
/** Max posts per Instagram hashtag batch */
const IG_MAX_ITEMS = 150;
/** Apify actor timeout in seconds — applies per actor run */
const ACTOR_TIMEOUT_SECS = 120;
/**
 * Max odometer for a "new owner" listing on FB Marketplace.
 * 5 000 mi catches the edge case of a dealer demo or cross-country delivery
 * before Claude applies the tighter VIO scoring (15–1000 mi green range).
 */
const FB_MAX_MILEAGE = 5_000;
/** Ninety days in milliseconds — reject posts older than this. */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

// ─── Purchase-intent phrases ──────────────────────────────────────────────────

/**
 * Phrases that indicate a recent purchase. Checked case-insensitively
 * against the listing description / Instagram caption.
 * Extends the Reddit set with social-media-specific phrasing.
 */
const PURCHASE_PHRASES: string[] = [
  "just picked up",
  "took delivery",
  "just bought",
  "new purchase",
  "pulled the trigger",
  "signed the papers",
  "drove it home",
  "finally got my",
  "picked her up",
  "picked him up",
  // Social-media specific
  "new car day",
  "newcarday",
  "just got my",
  "officially mine",
  "meet my new",
  "new addition to the family",
  "new family member",
  "welcome to the family",
  "bringing her home",
  "bringing him home",
  "new owner",
  "first drive",
];

// ─── SoCal signals ────────────────────────────────────────────────────────────

/**
 * SoCal location terms checked case-insensitively against caption + bio +
 * location name (Instagram) or description + location field (Facebook).
 * Tokens ≤4 chars are stored padded with a leading space to reduce false
 * positives during substring matching.
 */
const SOCAL_TERMS: string[] = [
  "socal",
  "so cal",
  "southern california",
  "los angeles",
  " la ",
  "l.a.",
  "san diego",
  "orange county",
  " oc ",
  "o.c.",
  "inland empire",
  " ie ",
  "riverside",
  "ventura",
  "santa barbara",
  "long beach",
  "anaheim",
  "irvine",
  "pasadena",
  "burbank",
  "glendale",
  "pomona",
  "ontario ca",
  "rancho cucamonga",
  "san bernardino",
  "palm springs",
  "coachella valley",
  "temecula",
  "murrieta",
  "torrance",
  "compton",
  "inglewood",
  "huntington beach",
  "costa mesa",
  "santa ana",
  "fullerton",
  "thousand oaks",
  "oxnard",
  "simi valley",
  "(213)",
  "(310)",
  "(323)",
  "(424)",
  "(562)",
  "(619)",
  "(626)",
  "(657)",
  "(714)",
  "(747)",
  "(760)",
  "(818)",
  "(858)",
  "(909)",
  "(949)",
];

/**
 * SoCal city/region strings used as the `locationQuery` input to the FB
 * Marketplace actor. The actor searches each independently; results are
 * merged and deduplicated. San Diego is separate because its 75 mi radius
 * doesn't overlap with the LA-centred query.
 */
const FB_SOCAL_LOCATIONS: Array<{ city: string; radiusMiles: number }> = [
  { city: "Los Angeles, CA",     radiusMiles: 75 },
  { city: "San Diego, CA",       radiusMiles: 60 },
];

// ─── Client singleton ─────────────────────────────────────────────────────────

let _apify: ApifyClient | null = null;

function getClient(): ApifyClient {
  if (_apify) return _apify;

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error(
      "APIFY_API_TOKEN is not set. Add it to .env.local or Vercel environment variables."
    );
  }

  _apify = new ApifyClient({ token });
  return _apify;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectPurchasePhrases(text: string): string[] {
  const lower = ` ${text} `.toLowerCase();
  return PURCHASE_PHRASES.filter((p) => lower.includes(p));
}

/**
 * Returns matched SoCal terms. Pads the combined string with a leading space
 * so short tokens like " la " don't match mid-word substrings.
 */
function detectSocalSignals(...texts: (string | null | undefined)[]): string[] {
  const combined = ` ${texts.filter(Boolean).join(" ")} `.toLowerCase();
  return SOCAL_TERMS.filter((term) => combined.includes(term));
}

/** Parse a loosely formatted mileage string like "12,345 mi" → 12345 */
function parseMileage(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const digits = raw.replace(/[^0-9]/g, "");
  const n = parseInt(digits, 10);
  return isNaN(n) ? null : n;
}

/** Parse a year from a string or number. Returns null if outside 1990–2030. */
function parseYear(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return isNaN(n) || n < 1990 || n > 2030 ? null : n;
}

/** Run an Apify actor and return its dataset items, typed as T[]. */
async function runActor<T>(
  client: ApifyClient,
  actorId: string,
  input: Record<string, unknown>
): Promise<T[]> {
  const run = await client.actor(actorId).call(input, {
    timeout: ACTOR_TIMEOUT_SECS,
    waitSecs: ACTOR_TIMEOUT_SECS + 10, // wait a little longer than the timeout
  });

  const dataset = await client
    .dataset(run.defaultDatasetId)
    .listItems({ clean: true });

  return (dataset.items ?? []) as T[];
}

// ─── Facebook Marketplace ─────────────────────────────────────────────────────

/** Raw item shape returned by apify/facebook-marketplace-scraper */
interface FbRawItem {
  id?: string;
  listingId?: string;
  url?: string;
  title?: string;
  description?: string;
  price?: string | number | null;
  mileage?: string | number | null;
  year?: string | number | null;
  make?: string | null;
  model?: string | null;
  sellerName?: string | null;
  sellerUrl?: string | null;
  sellerProfileUrl?: string | null;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  postedAt?: string | null;
  createdAt?: string | null;
}

/** Build the search query string for a vehicle. */
function buildFbSearchQuery(vehicle: VehiclePayload): string {
  const parts: (string | number)[] = [vehicle.year, vehicle.make, vehicle.model];
  if (vehicle.engine) parts.push(vehicle.engine);
  return parts.filter(Boolean).join(" ");
}

/**
 * Scrape Facebook Marketplace for low-mileage vehicle listings in SoCal that
 * contain a purchase-intent phrase in their description.
 *
 * Runs one actor call per SoCal location query in parallel, then merges and
 * deduplicates results by listingId.
 */
async function scrapeFacebookMarketplace(
  vehicle: VehiclePayload
): Promise<FacebookMarketplaceListing[]> {
  const client = getClient();
  const searchQuery = buildFbSearchQuery(vehicle);
  const cutoff = Date.now() - NINETY_DAYS_MS;

  // Fan out across SoCal locations in parallel
  const locationResults = await Promise.allSettled(
    FB_SOCAL_LOCATIONS.map(({ city, radiusMiles }) =>
      runActor<FbRawItem>(client, FB_ACTOR_ID, {
        searchQuery,
        locationQuery:  city,
        searchRadius:   radiusMiles,
        maxItems:       FB_MAX_ITEMS,
        // Request vehicle category to get structured mileage/year fields
        categoryId:     "vehicles",
      })
    )
  );

  const seen = new Set<string>();
  const listings: FacebookMarketplaceListing[] = [];

  for (const result of locationResults) {
    if (result.status === "rejected") {
      console.warn("[social/fb] location query failed:", result.reason);
      continue;
    }

    for (const raw of result.value) {
      const id = String(raw.id ?? raw.listingId ?? "");
      if (!id || seen.has(id)) continue;

      const title       = raw.title ?? "";
      const description = raw.description ?? "";
      const mileage     = parseMileage(raw.mileage);
      const year        = parseYear(raw.year);
      const postedAt    = raw.postedAt ?? raw.createdAt ?? null;
      const location    = raw.location ?? ([raw.city, raw.state].filter(Boolean).join(", ") || null);

      // ── Mileage gate: skip high-mileage listings early ────────────────────
      if (mileage !== null && mileage > FB_MAX_MILEAGE) continue;

      // ── Recency gate: skip posts older than 90 days ───────────────────────
      if (postedAt) {
        const ts = new Date(postedAt).getTime();
        if (!isNaN(ts) && ts < cutoff) continue;
      }

      // ── Purchase-intent filter ─────────────────────────────────────────────
      const matchedPhrases = detectPurchasePhrases(`${title} ${description}`);
      if (matchedPhrases.length === 0) continue;

      // ── SoCal confirmation ─────────────────────────────────────────────────
      // FB queries are already scoped to SoCal cities but the location field
      // lets us set the flag for downstream scoring.
      const socaSignals  = detectSocalSignals(location, description);
      const socaConfirmed = socaSignals.length > 0;

      seen.add(id);
      listings.push({
        listingId:        id,
        listingUrl:       raw.url ?? `https://www.facebook.com/marketplace/item/${id}`,
        title,
        description,
        price:            typeof raw.price === "number" ? raw.price : null,
        mileage,
        year,
        make:             raw.make ?? null,
        model:            raw.model ?? null,
        sellerName:       raw.sellerName ?? null,
        sellerProfileUrl: raw.sellerProfileUrl ?? raw.sellerUrl ?? null,
        location,
        postedAt,
        matchedPhrases,
        socaConfirmed,
      });
    }
  }

  return listings;
}

// ─── Instagram ────────────────────────────────────────────────────────────────

/** Raw item shape returned by apify/instagram-hashtag-scraper */
interface IgRawItem {
  id?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  hashtags?: string[];
  ownerUsername?: string;
  authorUsername?: string;
  ownerFullName?: string;
  authorFullName?: string;
  ownerBiography?: string;
  authorBio?: string;
  timestamp?: string;
  likesCount?: number;
  commentsCount?: number;
  locationName?: string;
  // some actor versions nest owner info
  owner?: {
    username?: string;
    fullName?: string;
    biography?: string;
  };
}

/**
 * Build Instagram hashtags to search for this vehicle.
 * Returns a deduplicated list of lowercase hashtags without the '#' prefix
 * (as required by the Apify actor input).
 */
function buildInstagramHashtags(vehicle: VehiclePayload): string[] {
  const make  = vehicle.make.toLowerCase().replace(/\s+/g, "");
  const model = vehicle.model.toLowerCase().replace(/[^a-z0-9]/g, "");

  const candidates = [
    `${make}${model}`,         // subaruwrx
    `new${make}`,              // newsubaru
    `${make}${model}life`,     // subaruwrxlife
    `${make}life`,             // subarulife
    `${make}owner`,            // subaruowner
    `${make}nation`,           // subarunation
    `${make}family`,           // subarufamily
    // Universal new-owner tags
    "newcarday",
    "newcar",
    "newcarowner",
    "justpickedup",
    "tookdelivery",
    "newaddition",
  ];

  // Deduplicate while preserving order
  return Array.from(new Set(candidates));
}

/**
 * Scrape Instagram for posts tagged with vehicle-specific hashtags.
 * Filters to posts from the last 90 days that mention a purchase phrase
 * and contain a SoCal location signal in caption, bio, or location name.
 */
async function scrapeInstagram(vehicle: VehiclePayload): Promise<InstagramPost[]> {
  const client    = getClient();
  const hashtags  = buildInstagramHashtags(vehicle);
  const cutoff    = Date.now() - NINETY_DAYS_MS;

  let rawItems: IgRawItem[] = [];
  try {
    rawItems = await runActor<IgRawItem>(client, IG_ACTOR_ID, {
      hashtags,
      resultsLimit: IG_MAX_ITEMS,
    });
  } catch (err) {
    console.warn("[social/instagram] actor run failed:", err);
    return [];
  }

  const seen  = new Set<string>();
  const posts: InstagramPost[] = [];

  for (const raw of rawItems) {
    const id = String(raw.id ?? raw.shortCode ?? "");
    if (!id || seen.has(id)) continue;

    const caption   = raw.caption ?? "";
    const timestamp = raw.timestamp ?? "";
    const username  = raw.ownerUsername ?? raw.authorUsername ?? raw.owner?.username ?? "";
    const fullName  = raw.ownerFullName ?? raw.authorFullName ?? raw.owner?.fullName ?? null;
    const bio       = raw.ownerBiography ?? raw.authorBio ?? raw.owner?.biography ?? null;
    const location  = raw.locationName ?? null;

    // ── Recency gate ──────────────────────────────────────────────────────────
    if (timestamp) {
      const ts = new Date(timestamp).getTime();
      if (!isNaN(ts) && ts < cutoff) continue;
    }

    // ── Purchase-intent filter ─────────────────────────────────────────────
    const matchedPhrases = detectPurchasePhrases(`${caption} ${bio ?? ""}`);
    if (matchedPhrases.length === 0) continue;

    // ── SoCal filter ──────────────────────────────────────────────────────────
    const socaSignals = detectSocalSignals(caption, bio, location);
    if (socaSignals.length === 0) continue; // Instagram is global — require SoCal signal

    // Which of our search hashtags appeared in this post
    const postTags       = (raw.hashtags ?? []).map((h) => h.toLowerCase().replace(/^#/, ""));
    const searchTags     = hashtags.map((h) => h.toLowerCase());
    const matchedHashtags = searchTags.filter((h) => postTags.includes(h));

    seen.add(id);
    posts.push({
      postId:           id,
      shortcode:        raw.shortCode ?? id,
      url:              raw.url ?? `https://www.instagram.com/p/${raw.shortCode ?? id}/`,
      caption,
      hashtags:         raw.hashtags ?? [],
      authorUsername:   username,
      authorFullName:   fullName,
      authorBio:        bio,
      timestamp,
      likesCount:       raw.likesCount ?? 0,
      commentsCount:    raw.commentsCount ?? 0,
      locationName:     location,
      matchedPhrases,
      matchedHashtags,
      socaConfirmed:    true, // we required socaSignals.length > 0 above
      socaSignals,
    });
  }

  return posts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ScrapeSocialResult {
  facebookListings: FacebookMarketplaceListing[];
  instagramPosts: InstagramPost[];
}

/**
 * Run both Facebook Marketplace and Instagram scrapers in parallel.
 * A failure in one source does not abort the other.
 */
export async function scrapeSocial(vehicle: VehiclePayload): Promise<ScrapeSocialResult> {
  const [fbResult, igResult] = await Promise.allSettled([
    scrapeFacebookMarketplace(vehicle),
    scrapeInstagram(vehicle),
  ]);

  const facebookListings =
    fbResult.status === "fulfilled" ? fbResult.value : [];
  const instagramPosts =
    igResult.status === "fulfilled" ? igResult.value : [];

  if (fbResult.status === "rejected") {
    console.error("[social/fb] scraper failed:", fbResult.reason);
  }
  if (igResult.status === "rejected") {
    console.error("[social/instagram] scraper failed:", igResult.reason);
  }

  return { facebookListings, instagramPosts };
}
