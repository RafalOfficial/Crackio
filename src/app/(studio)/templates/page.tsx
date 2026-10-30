import type { Metadata } from "next";
import { TemplatesLibrary } from "@/components/templates/TemplatesLibrary";

export const metadata: Metadata = { title: "Templates", description: "Clips to star in, made by Crackio on open models: put yourself, a friend or a product into one, or bring your own clip." };

export default function Page() {
  return <TemplatesLibrary />;
}
