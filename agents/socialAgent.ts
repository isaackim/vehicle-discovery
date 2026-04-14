/**
 * Adapts FacebookMarketplaceListing and InstagramPost objects from
 * agents/social.ts into the canonical LeadCandidate shape consumed by
 * the LangGraph pipeline.
 */

import type { VehiclePayload } from "@/types/inngest";
import type { LeadCandidate } from "@/types/leads";
import type { FacebookMarketplaceListing, InstagramPost } from "@/types/social";
import { scrapeSocial } from "./social";

function fbListingToCandidate(listing: FacebookMarketplaceListing): LeadCandidate {
  // Feed all text Claude might need: title, description, seller, location
  const rawText = [
    listing.title,
    listing.description,
    listing.sellerName ? `Seller: ${listing.sellerName}` : null,
    listing.location   ? `Location: ${listing.location}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    source:           "social",
    sourceUrl:        listing.listingUrl,
    rawText,
    scrapedAt:        new Date().toISOString(),
    sourceCreatedAt:  listing.postedAt ?? undefined,
    platformSubsource: "facebook_marketplace",
    // Pre-extraction hints from the structured listing fields
    make:     listing.make    ?? undefined,
    model:    listing.model   ?? undefined,
    year:     listing.year    ?? undefined,
    mileage:  listing.mileage ?? undefined,
    location: listing.location ?? undefined,
    contactInfo: listing.sellerProfileUrl ?? undefined,
  };
}

function igPostToCandidate(post: InstagramPost): LeadCandidate {
  // Feed caption + author info together so Claude can extract person + location
  const rawText = [
    post.caption,
    post.authorFullName ? `Author: ${post.authorFullName} (@${post.authorUsername})` : `@${post.authorUsername}`,
    post.authorBio      ? `Bio: ${post.authorBio}` : null,
    post.locationName   ? `Location: ${post.locationName}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    source:            "social",
    sourceUrl:         post.url,
    rawText,
    scrapedAt:         new Date().toISOString(),
    sourceCreatedAt:   post.timestamp,
    platformSubsource: "instagram",
    location:          post.locationName ?? undefined,
    contactInfo:       `https://www.instagram.com/${post.authorUsername}/`,
  };
}

export async function runSocialAgent(vehicle: VehiclePayload): Promise<LeadCandidate[]> {
  const { facebookListings, instagramPosts } = await scrapeSocial(vehicle);

  return [
    ...facebookListings.map(fbListingToCandidate),
    ...instagramPosts.map(igPostToCandidate),
  ];
}
