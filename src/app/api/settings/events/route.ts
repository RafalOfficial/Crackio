import { listGenerations } from "@/lib/server/db";
import { setupJobs } from "@/lib/server/setup/jobs";
import { creditNow, idleEnded } from "@/lib/server/setup/cloud-money";
import { kitById } from "@/lib/setup/kits";
import type { CrackioEvent } from "@/lib/setup/types";

/**
 * What happened since `?since=` (ms), for notifications: takes of 30 s or more that finished or failed, set-ups that
 * ended, boxes Crackio stopped or deleted for being idle, and a cloud account's credit under an hour. Newest first, at
 * most 20.
 */

const TOOL: Record<string, string> = {
  image: "Your picture",
  video: "Your clip",
  cast: "Your Cast picture",
  director: "Your Director shot",
  storyboard: "Your storyboard frame",
  angles: "Your new angle",
  relight: "Your relit picture",
  retouch: "Your retouch",
  product: "Your product shot",
  upscale: "Your upscale",
  templates: "Your swap",
  recast: "Your swap",
  voice: "Your voice take",
  lipsync: "Your lip sync",
  motion: "Your motion clip",
};
const ICONS = new Set(["angles", "cast", "director", "image", "lipsync", "motion", "product", "recast", "relight", "retouch", "storyboard", "templates", "upscale", "video", "voice"]);

const took = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)} min`);

export async function GET(request: Request) {
  const since = Number(new URL(request.url).searchParams.get("since")) || Date.now() - 60_000;
  const events: CrackioEvent[] = [];

  for (const g of listGenerations({ limit: 40 })) {
    if (!g.finishedAt || g.finishedAt <= since || (g.status !== "done" && g.status !== "error")) continue;
    if (g.error === "Cancelled.") continue;
    const ms = g.finishedAt - (g.startedAt ?? g.createdAt);
    if (ms < 30_000) continue;
    const what = TOOL[g.tool] ?? "Your take";
    events.push({
      id: `take-${g.id}`,
      at: g.finishedAt,
      kind: "take",
      ok: g.status === "done",
      title: g.status === "done" ? `${what} is ready` : `${what} didn't finish`,
      body: g.status === "done" ? `${g.modelName ?? "Done"} · took ${took(ms)}` : (g.error ?? "It stopped."),
      href: g.status === "done" ? `/library?view=${encodeURIComponent(g.id)}` : "/library",
      icon: ICONS.has(g.tool) ? `/icons/${g.tool}.png` : "/apple-icon.png",
    });
  }

  for (const j of setupJobs()) {
    if (!j.finishedAt || j.finishedAt <= since) continue;
    const names = j.kits.map((k) => kitById(k)?.name ?? k).join(", ");
    events.push({
      id: `setup-${j.id}`,
      at: j.finishedAt,
      kind: "setup",
      ok: j.state === "done",
      title: j.state === "done" ? `${names} is set up on ${j.machineLabel}` : j.state === "stopped" ? `${names} set-up stopped` : `${names} didn't set up on ${j.machineLabel}`,
      body: j.state === "done" ? "Ready to use." : (j.error ?? "Open Settings → Tools to try again."),
      href: `/settings/tools?machine=${encodeURIComponent(j.machine)}`,
      icon: "/icons/settings.png",
    });
  }

  for (const b of idleEnded()) {
    if (b.at <= since) continue;
    events.push({
      id: `box-${b.box}-${b.at}`,
      at: b.at,
      kind: "box",
      ok: true,
      title: b.deleted ? "A rented GPU deleted itself" : "A rented GPU stopped itself",
      body: b.deleted
        ? `${b.label} (#${b.box.split(":")[1]}) was idle for ${b.minutes} min, so Crackio deleted it, as you asked. Nothing bills for it any more.`
        : `${b.label} (#${b.box.split(":")[1]}) was idle for ${b.minutes} min, so Crackio stopped it. Its disk is kept: Start brings it back.`,
      href: "/settings/machines",
      icon: "/icons/settings.png",
    });
  }

  for (const c of creditNow()) {
    if (c.hoursLeft === null || c.until === null || c.hoursLeft >= 1) continue;
    const name = c.provider === "vast" ? "vast.ai" : "RunPod";
    // One per account, replaced in place as it's read again (the notification's tag is its id).
    events.push({
      id: `credit-${c.provider}`,
      at: c.at,
      kind: "credit",
      ok: false,
      title: `${name} credit runs out in ${Math.max(1, Math.round(c.hoursLeft * 60))} min`,
      body: `$${c.balance.toFixed(2)} left at $${c.perHour.toFixed(2)} an hour. Top up, or stop a box you don't need.`,
      href: "/settings/machines",
      icon: "/icons/settings.png",
    });
  }

  events.sort((a, b) => b.at - a.at);
  return Response.json({ events: events.slice(0, 20), now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
