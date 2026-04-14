/** Raw listing returned by the Apify Facebook Marketplace actor. */
export interface FacebookMarketplaceListing {
  // ── Identity ────────────────────────────────────────────────────────────────
  listingId: string;
  listingUrl: string;

  // ── Content ─────────────────────────────────────────────────────────────────
  title: string;
  description: string;
  price: number | null;

  // ── Vehicle details (populated for vehicle-category listings) ───────────────
  mileage: number | null;
  year: number | null;
  make: string | null;
  model: string | null;

  // ── Seller ──────────────────────────────────────────────────────────────────
  sellerName: string | null;
  sellerProfileUrl: string | null;

  // ── Location ────────────────────────────────────────────────────────────────
  /** City/state string as returned by Apify, e.g. "Los Angeles, CA" */
  location: string | null;

  // ── Timestamp ───────────────────────────────────────────────────────────────
  /** ISO 8601 — null when the actor doesn't surface an exact date */
  postedAt: string | null;

  // ── Match metadata (populated by agents/social.ts, not the actor) ───────────
  matchedPhrases: string[];
  socaConfirmed: boolean;
}

/** Raw post returned by the Apify Instagram hashtag actor. */
export interface InstagramPost {
  // ── Identity ────────────────────────────────────────────────────────────────
  postId: string;
  shortcode: string;
  url: string;

  // ── Content ─────────────────────────────────────────────────────────────────
  caption: string;
  hashtags: string[];

  // ── Author ──────────────────────────────────────────────────────────────────
  authorUsername: string;
  authorFullName: string | null;
  /** Bio text — often contains location info for car owners */
  authorBio: string | null;

  // ── Engagement ──────────────────────────────────────────────────────────────
  timestamp: string; // ISO 8601
  likesCount: number;
  commentsCount: number;

  // ── Location ────────────────────────────────────────────────────────────────
  /** Tagged location name, e.g. "Los Angeles, California" */
  locationName: string | null;

  // ── Match metadata (populated by agents/social.ts, not the actor) ───────────
  matchedPhrases: string[];
  /** Which search hashtags caused this post to be fetched */
  matchedHashtags: string[];
  socaConfirmed: boolean;
  socaSignals: string[];
}
