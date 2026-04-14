import type { Metadata } from "next";
import { ResultsClient } from "./ResultsClient";

export const metadata: Metadata = {
  title: "Leads — Dyno Lead Agent",
  description: "Live lead results from the vehicle scraping pipeline",
};

export default function ResultsPage() {
  return <ResultsClient />;
}
