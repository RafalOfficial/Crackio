import type { Metadata } from "next";
import { DirectorClassicClient } from "@/components/director/DirectorClient";

export const metadata: Metadata = {
  title: "Director (classic)",
  description: "The classic Director, kept while Director v2 settles.",
};

export default function DirectorClassicPage() {
  return <DirectorClassicClient />;
}
