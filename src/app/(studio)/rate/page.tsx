import type { Metadata } from "next";
import { RateView } from "@/components/rate/RateView";

export const metadata: Metadata = { title: "Rate", description: "Pick the better of two results with the arrow keys; your picks teach Crackio's own models your taste." };

/** /rate: swap takes; /rate?task=chat: two replies in a conversation. */
export default async function Page({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const task = (await searchParams).task === "chat" ? "chat" : "swap";
  return <RateView task={task} />;
}
