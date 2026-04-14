/** Raw signal from the Reddit agent before Claude NLP extraction */
export interface RedditSignal {
  // ── Post identity ───────────────────────────────────────────────────────────
  postId: string;
  subreddit: string;
  title: string;
  body: string; // selftext for text posts; empty string for link posts
  author: string;
  postUrl: string; // absolute URL, e.g. https://reddit.com/r/subaru/comments/...
  permalink: string; // relative, e.g. /r/subaru/comments/...

  // ── Reddit engagement signals ───────────────────────────────────────────────
  score: number;
  upvoteRatio: number;
  numComments: number;
  flair: string | null;
  createdAt: string; // ISO 8601

  // ── Match metadata ──────────────────────────────────────────────────────────
  /** Which purchase-intent phrases were found in the post */
  matchedPhrases: string[];
  /** True when a SoCal location signal was found OR the subreddit is SoCal-specific */
  socaConfirmed: boolean;
  /** Which location terms/area codes triggered the SoCal match */
  socaSignals: string[];
}
