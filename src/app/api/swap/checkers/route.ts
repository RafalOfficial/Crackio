import { checkerState } from "@/lib/server/swap-checker";

/**
 * The Swap page's Checks row: which checker is picked, and whether each can run now (Crackio's judge on one of your
 * GPUs; Gemini on your Comfy key, asked one word so a key out of credits shows here, not mid-swap).
 */
export async function GET() {
  return Response.json(await checkerState(true), { headers: { "Cache-Control": "no-store" } });
}
