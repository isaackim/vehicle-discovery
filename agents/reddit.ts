/**
 * Reddit agent — searches make-specific subreddits and r/whatcarmatch for
 * recent purchase-intent posts, then filters by SoCal location signals.
 *
 * Uses snoowrap (PRAW-compatible Node.js Reddit API wrapper).
 * Rate-limited to stay under Reddit's OAuth cap (60 req/min).
 * Returns raw RedditSignal objects — normalization happens in redditAgent.ts.
 */

import Snoowrap from "snoowrap";
import type { VehiclePayload } from "@/types/inngest";
import type { RedditSignal } from "@/types/reddit";

// ─── Constants ────────────────────────────────────────────────────────────────

const NINETY_DAYS_S = 90 * 24 * 60 * 60;

/**
 * Purchase-intent phrases — what a new owner would write in the first days.
 * Stored without quotes; the Lucene query builder wraps them.
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
];

/**
 * General automotive subreddits always included regardless of make.
 * Sorted by signal quality descending.
 */
const BASE_SUBREDDITS: string[] = [
  "whatcarmatch",
  "cars",
  "askcarsales",
  "carbuying",
];

/**
 * SoCal-specific subreddits — posts here pass the location filter automatically;
 * no extra SoCal text matching is needed.
 */
const SOCAL_SUBREDDITS: string[] = [
  "socal",
  "LosAngeles",
  "orangecounty",
  "sandiego",
  "InlandEmpire",
];

/**
 * SoCal location signals.
 * Short tokens (≤4 chars) are wrapped in spaces / punctuation during matching
 * to reduce false positives (e.g. " la " avoids matching "solar", "flair").
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
  // SoCal area codes (formatted as they'd appear in posts)
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
 * Make → subreddit mapping.
 * Index key is lowercase make name matching VehiclePayload.make.toLowerCase().
 * Falls back to [make.toLowerCase()] when not found.
 */
const MAKE_SUBREDDITS: Record<string, string[]> = {
  acura: ["Acura", "AcuraRDX", "NSX"],
  audi: ["Audi", "AudiA4", "AudiQ5", "audiq3"],
  bmw: ["BMW", "BmwTech", "e90", "f30", "g20", "BMWM"],
  buick: ["Buick"],
  cadillac: ["Cadillac"],
  chevrolet: ["Chevrolet", "camaro", "Corvette", "silverado", "ColoradoTruck"],
  chrysler: ["Chrysler"],
  dodge: ["Dodge", "Charger", "Challenger", "ram_trucks"],
  ford: ["Ford", "Mustang", "f150", "FordTruck", "Bronco", "fordmaverick"],
  genesis: ["GenesisMotors"],
  gmc: ["GMC", "sierraGMC"],
  honda: ["Honda", "civic", "accord", "HondaTech", "crv", "fit"],
  hyundai: ["Hyundai", "veloster", "elantra", "Sonata", "HyundaiIoniq"],
  infiniti: ["infiniti", "G35", "G37"],
  jeep: ["Jeep", "WranglerJL", "Gladiator", "GrandCherokee"],
  kia: ["kia", "Stinger", "telluride", "KiaEV6"],
  lexus: ["Lexus", "LexusIS", "LexusGS", "LexusRX"],
  lincoln: ["lincolnmotorco"],
  mazda: ["mazda", "mazda3", "miata", "Mazdaspeed3", "CX5"],
  mercedes: ["mercedes_benz", "AMG", "GClass"],
  mitsubishi: ["mitsubishi", "EvoX", "lancer"],
  nissan: ["Nissan", "370z", "GTR", "NissanLeaf", "Nismo"],
  porsche: ["Porsche", "Porsche911", "Porsche718", "PorscheMAcan"],
  ram: ["ram_trucks", "Dodge"],
  rivian: ["Rivian"],
  subaru: ["subaru", "WRX", "STI", "Crosstrek", "Outback", "Forester", "BRZ"],
  tesla: ["teslamotors", "TeslaModelY", "TeslaModel3", "ModelX"],
  toyota: ["toyota", "Tacoma", "Camry", "corolla", "4Runner", "Supra", "GR86", "Tundra", "Sienna"],
  volkswagen: ["volkswagen", "GTI", "GolfGTI", "Jetta", "Passat", "VWiD4"],
  volvo: ["Volvo", "volvocars", "VolvoXC90"],
};

// ─── Client ───────────────────────────────────────────────────────────────────

let _client: Snoowrap | null = null;

function getClient(): Snoowrap {
  if (_client) return _client;

  if (
    !process.env.REDDIT_CLIENT_ID ||
    !process.env.REDDIT_CLIENT_SECRET ||
    !process.env.REDDIT_USER_AGENT ||
    !process.env.REDDIT_USERNAME ||
    !process.env.REDDIT_PASSWORD
  ) {
    throw new Error(
      "Reddit credentials missing. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, " +
        "REDDIT_USER_AGENT, REDDIT_USERNAME, REDDIT_PASSWORD in .env.local"
    );
  }

  _client = new Snoowrap({
    userAgent: process.env.REDDIT_USER_AGENT,
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    username: process.env.REDDIT_USERNAME,
    password: process.env.REDDIT_PASSWORD,
  });

  // ~55 req/min — safely under the 60 req/min OAuth cap
  _client.config({
    requestDelay: 1100,
    continueAfterRatelimitError: true,
    maxRetryAttempts: 3,
    warnings: false,
  });

  return _client;
}

// ─── Query builder ────────────────────────────────────────────────────────────

/** Builds a Lucene OR query from the purchase-intent phrase list. */
function buildSearchQuery(): string {
  return PURCHASE_PHRASES.map((p) => `"${p}"`).join(" OR ");
}

// ─── Subreddit targeting ─────────────────────────────────────────────────────

function getTargetSubreddits(vehicle: VehiclePayload): {
  subreddits: string[];
  socalSubSet: Set<string>;
} {
  const make = vehicle.make.toLowerCase();
  const isGeneric = make === "any";

  const makeSpecific: string[] = isGeneric
    ? [] // broad cron run — don't target any single make
    : (MAKE_SUBREDDITS[make] ?? [make]); // fall back to r/{make}

  const all = [
    ...makeSpecific,
    ...BASE_SUBREDDITS,
    ...SOCAL_SUBREDDITS,
  ];

  return {
    subreddits: [...new Set(all)], // deduplicate
    socalSubSet: new Set(SOCAL_SUBREDDITS.map((s) => s.toLowerCase())),
  };
}

// ─── Signal detection ─────────────────────────────────────────────────────────

function detectPurchasePhrases(title: string, body: string): string[] {
  const combined = `${title} ${body}`.toLowerCase();
  return PURCHASE_PHRASES.filter((p) => combined.includes(p));
}

/**
 * Checks title, body, and flair for SoCal location signals.
 * Pads the combined text with spaces so " la " doesn't hit "flask", etc.
 */
function detectSocalSignals(
  title: string,
  body: string,
  flair: string | null
): string[] {
  const combined = ` ${[flair ?? "", title, body].join(" ")} `.toLowerCase();
  return SOCAL_TERMS.filter((term) => combined.includes(term.toLowerCase()));
}

// ─── Per-subreddit search ─────────────────────────────────────────────────────

async function searchSubreddit(
  client: Snoowrap,
  subreddit: string,
  query: string,
  isSocalSub: boolean,
  cutoffUtc: number
): Promise<RedditSignal[]> {
  let posts: Snoowrap.Submission[];

  try {
    const listing = await client.getSubreddit(subreddit).search({
      query,
      sort: "new",
      time: "year", // Reddit max; we filter to 90 days below
      limit: 100,
      syntax: "lucene",
    });
    posts = Array.from(listing as unknown as Snoowrap.Submission[]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Private, banned, or non-existent subreddit — skip without throwing
    if (
      /403|404|forbidden|banned|private|quarantine/i.test(msg)
    ) {
      console.warn(`[reddit] r/${subreddit} skipped: ${msg}`);
      return [];
    }
    throw err;
  }

  const signals: RedditSignal[] = [];

  for (const post of posts) {
    // ── Date filter ─────────────────────────────────────────────────────────
    if (post.created_utc < cutoffUtc) continue;

    const title = post.title ?? "";
    const body = post.selftext ?? "";
    const flair = post.link_flair_text ?? null;

    // ── Purchase-intent filter ──────────────────────────────────────────────
    const matchedPhrases = detectPurchasePhrases(title, body);
    if (matchedPhrases.length === 0) continue;

    // ── SoCal filter ────────────────────────────────────────────────────────
    const socaSignals = detectSocalSignals(title, body, flair);
    const socaConfirmed = isSocalSub || socaSignals.length > 0;
    if (!socaConfirmed) continue;

    // ── Author name ─────────────────────────────────────────────────────────
    // snoowrap types author as RedditUser but it can be a stub {name: string}
    const author =
      typeof post.author === "object" && post.author !== null
        ? (post.author as unknown as { name: string }).name ?? "[deleted]"
        : "[deleted]";

    signals.push({
      postId: post.id,
      subreddit,
      title,
      body,
      author,
      postUrl: `https://www.reddit.com${post.permalink}`,
      permalink: post.permalink,
      score: post.score,
      upvoteRatio: post.upvote_ratio,
      numComments: post.num_comments,
      flair,
      createdAt: new Date(post.created_utc * 1000).toISOString(),
      matchedPhrases,
      socaConfirmed,
      socaSignals,
    });
  }

  return signals;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Scrapes Reddit for new-purchase posts matching the vehicle and SoCal signals.
 *
 * @param vehicle - Vehicle search context from the Inngest payload
 * @returns Raw RedditSignal objects, deduplicated across subreddits
 */
export async function scrapeReddit(vehicle: VehiclePayload): Promise<RedditSignal[]> {
  const client = getClient();
  const query = buildSearchQuery();
  const cutoffUtc = Math.floor(Date.now() / 1000) - NINETY_DAYS_S;
  const { subreddits, socalSubSet } = getTargetSubreddits(vehicle);

  console.info(
    `[reddit] Searching ${subreddits.length} subreddits for: ` +
      `${vehicle.year} ${vehicle.make} ${vehicle.model}`
  );

  // Run all subreddit searches in parallel — snoowrap queues internally
  // to respect the rate limit, so Promise.all is safe here.
  const settled = await Promise.allSettled(
    subreddits.map((sub) =>
      searchSubreddit(
        client,
        sub,
        query,
        socalSubSet.has(sub.toLowerCase()),
        cutoffUtc
      )
    )
  );

  const allSignals: RedditSignal[] = [];
  const seen = new Set<string>(); // postId → deduplicate cross-subreddit

  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[reddit] subreddit search failed:", result.reason);
      continue;
    }
    for (const signal of result.value) {
      if (!seen.has(signal.postId)) {
        seen.add(signal.postId);
        allSignals.push(signal);
      }
    }
  }

  // Sort newest first
  allSignals.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  console.info(
    `[reddit] Found ${allSignals.length} signals ` +
      `(${allSignals.filter((s) => s.socaConfirmed).length} SoCal-confirmed)`
  );

  return allSignals;
}
