import { Suspense } from "react";
import type { Metadata } from "next";
import { RateView } from "@/components/rate/RateView";

export const metadata: Metadata = { title: "Rate", description: "Pick the better of two results with the arrow keys; your picks teach Crackio's own models your taste." };

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * /rate: swap takes; /rate?task=chat: two replies in a conversation. The query is read inside a boundary, so a
 * navigation shows the page's frame at once instead of waiting for it.
 */
export default function Page({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<div className="mx-auto h-[70vh] max-w-[1440px] px-4 pt-6 sm:px-6 lg:px-10 lg:pt-8"><div className="skeleton h-full rounded-panel" /></div>}>
      <Rate searchParams={searchParams} />
    </Suspense>
  );
}

async function Rate({ searchParams }: { searchParams: Search }) {
  const task = (await searchParams).task === "chat" ? "chat" : "swap";
  return <RateView task={task} />;
}
