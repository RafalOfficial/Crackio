"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, FlaskConical, Plus, Radar, Square } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { KNOWN_GPUS, type Blocked, type FeedKind, type Hunt, type MarketGpu, type RentKit, type RentLook, type RentOffer, type RentedNow } from "@/lib/rent/types";
import { ConfirmButton, Heading, Lamp, Loading, ProblemCard, Tape, Verdict } from "./parts";
import { RentKitEditor } from "./RentKitEditor";
import type { Tone } from "./words";

/**
 * Settings → Rent: pick the cards and your limits once (a kit), switch it on, and Crackio watches vast.ai and rents the
 * first box that fits. The market is shown as it is now (what fits, and what nearly does and why not), with a blacklist
 * for machines that don't work.
 */

type Offers = { fits: RentOffer[]; near: RentOffer[] };
type Look = RentLook & { market?: MarketGpu[]; marketAt?: number | null; boxes?: RentedNow[]; error?: string };

/** "$0.35", "$0.188", "$1.20": three places under a dollar only when the third says something. */
const money = (n: number) => `$${n < 1 && Math.round(n * 1000) % 10 ? n.toFixed(3) : n.toFixed(2)}`;
const live = (h: Hunt | undefined) => Boolean(h && (h.state === "hunting" || h.state === "renting" || h.state === "starting"));
const kitLine = (k: RentKit) => (k.gpus.length ? `${k.gpus.slice(0, 2).join(", ")}${k.gpus.length > 2 ? ` +${k.gpus.length - 2}` : ""} · ${money(k.maxPrice)}/h` : "No card picked yet");

async function post(body: Record<string, unknown>): Promise<(Look & { kit?: RentKit } & Partial<Offers>) | { error: string }> {
  const res = await fetch("/api/rent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { error: "Crackio didn't answer." };
  return (await res.json().catch(() => ({ error: "Crackio didn't answer." }))) as Look;
}

export function RentView() {
  const [look, setLook] = useState<Look | null>(null);
  const [market, setMarket] = useState<MarketGpu[]>([]);
  const [boxes, setBoxes] = useState<RentedNow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<RentKit | null>(null);
  const [offers, setOffers] = useState<Offers | null>(null);
  const [lookSaid, setLookSaid] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the card list has arrived: a first look the market refused is asked for again.
  const haveMarket = useRef(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const anyLive = Boolean(look?.hunts.some(live));

  const take = useCallback((next: Look | { error: string }) => {
    if ("error" in next && next.error && !("kits" in next)) return setSaid(next.error);
    const l = next as Look;
    setLook((was) => ({ ...was, ...l }));
    if (l.market?.length) {
      setMarket(l.market);
      haveMarket.current = true;
    }
    if (l.boxes) setBoxes(l.boxes);
    setSaid(l.error ?? null);
  }, []);

  // The first look brings the market and your boxes; later ones only what changes (kits, hunts, the blacklist).
  useEffect(() => {
    let alive = true;
    fetch("/api/rent?market=1&boxes=1", { cache: "no-store" })
      .then((r) => r.json() as Promise<Look>)
      .then((l) => {
        if (!alive) return;
        take(l);
        const first = l.hunts.find(live)?.kit ?? l.kits[0]?.id ?? null;
        setSel(first);
        setDraft(l.kits.find((k) => k.id === first) ?? null);
      })
      .catch(() => alive && setSaid("Crackio didn't answer."));
    return () => {
      alive = false;
    };
  }, [take]);

  // A hunt's feed moves every few seconds; with none on, the page looks again now and then. Never while it's hidden.
  useEffect(() => {
    const t = setInterval(
      () => {
        if (document.visibilityState !== "visible") return;
        fetch(haveMarket.current ? "/api/rent" : "/api/rent?market=1&boxes=1", { cache: "no-store" })
          .then((r) => r.json() as Promise<Look>)
          .then(take)
          .catch(() => {});
      },
      anyLive ? 3000 : 15_000,
    );
    return () => clearInterval(t);
  }, [anyLive, take]);

  // What fits the kit as it is on screen: asked for a moment after the last change, then every 30 s. Only the fits:
  // vast.ai counts every row a search returns against a daily allowance, and a look for fits returns next to none.
  // What's close (and why it isn't a fit) costs more rows, so it's looked up when you ask for it.
  const draftKey = draft ? JSON.stringify(draft) : "";
  useEffect(() => {
    if (!draftKey) return;
    const kit = JSON.parse(draftKey) as RentKit;
    let alive = true;
    const ask = () => {
      if (document.visibilityState !== "visible" || !kit.gpus.length) return;
      void post({ action: "look", kit }).then((r) => {
        if (!alive) return;
        if ("search" in r && r.search) setLook((was) => (was ? { ...was, search: r.search! } : was));
        if ("fits" in r && r.fits) setOffers((was) => ({ fits: r.fits!, near: was?.near ?? [] }));
        // A look that failed says why, instead of "Looking…" for ever.
        setLookSaid("fits" in r && r.fits ? null : (("error" in r && r.error) || "vast.ai didn't answer."));
      });
    };
    const first = setTimeout(ask, 900);
    const again = setInterval(ask, 30_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(again);
    };
  }, [draftKey]);

  if (!look) return <Loading rows={6} />;

  const hunt = look.hunts.find((h) => h.kit === sel);
  const locked = live(hunt);

  function pick(id: string) {
    setSel(id);
    setDraft(look!.kits.find((k) => k.id === id) ?? null);
    setOffers(null);
  }

  function change(patch: Partial<RentKit>) {
    if (!draft || locked) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    if (saving.current) clearTimeout(saving.current);
    saving.current = setTimeout(() => void post({ action: "save-kit", kit: next }).then(take), 500);
  }

  async function add() {
    const out = await post({ action: "new-kit" });
    take(out);
    if ("kit" in out && out.kit) {
      setSel(out.kit.id);
      setDraft(out.kit);
      setOffers(null);
    }
  }

  async function remove() {
    if (!draft) return;
    const out = await post({ action: "delete-kit", id: draft.id });
    take(out);
    const rest = "kits" in out ? out.kits : [];
    setSel(rest[0]?.id ?? null);
    setDraft(rest[0] ?? null);
    setOffers(null);
  }

  const act = (body: Record<string, unknown>) => post(body).then(take);

  /** What's close to the kit and why it isn't a fit: one wider search, on request. */
  async function seeClose() {
    if (!draft) return;
    setCloseBusy(true);
    const r = await post({ action: "look", kit: draft, wide: true });
    setCloseBusy(false);
    if ("search" in r && r.search) setLook((was) => (was ? { ...was, search: r.search! } : was));
    if ("fits" in r && r.fits && r.near) setOffers({ fits: r.fits, near: r.near });
    else setLookSaid(("error" in r && r.error) || "vast.ai didn't answer.");
  }

  const until = look.search?.blockedUntil ?? null;

  return (
    <div className="space-y-10">
      <Verdict
        title="Rent"
        facts="Pick the cards and your limits. Crackio watches vast.ai and rents the first box that fits."
        aside={
          <>
            {look.search ? (
              <span
                title={`vast.ai lets an account search ${look.search.vastLimit.toLocaleString("en-US")} rows a day, on its site and here together. Crackio stops itself at ${look.search.limit.toLocaleString("en-US")}, so the rest stays for renting by hand.`}
                className={cn("rounded-full bg-white/[0.05] px-3 py-1.5 text-[12.5px] font-semibold tabular-nums shadow-[inset_0_0_0_1px_var(--color-line)]", look.search.used >= look.search.limit * 0.8 ? "text-tungsten" : "text-fog")}
              >
                Searches today {look.search.used.toLocaleString("en-US")} / {look.search.limit.toLocaleString("en-US")}
              </span>
            ) : null}
            {look.balance != null ? <span className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[12.5px] font-semibold tabular-nums text-fog shadow-[inset_0_0_0_1px_var(--color-line)]">${look.balance.toFixed(2)} on vast.ai</span> : null}
          </>
        }
      />

      {!look.key ? (
        <ProblemCard tone="needs" title="Add your vast.ai key first" why="Rent searches and rents through your own vast.ai account." action={<ButtonLink href="/settings/accounts" size="sm" variant="outline">Accounts</ButtonLink>} />
      ) : null}

      {until ? (
        <ProblemCard
          tone="needs"
          title={`${look.search.own ? "Crackio has used its own share of vast.ai's daily searches" : "vast.ai's daily search allowance is used up"}. Rent can look again at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}.`}
          why={
            look.search.own
              ? `Crackio stops itself at ${look.search.limit.toLocaleString("en-US")} of vast.ai's ${look.search.vastLimit.toLocaleString("en-US")} search rows a day, so you can still search and rent on vast.ai yourself.`
              : `An account gets ${look.search.vastLimit.toLocaleString("en-US")} search rows a day, on vast.ai's site and here together. A hunt that's on waits and carries on by itself.`
          }
        />
      ) : null}

      {/* Kits: each a saved set of limits. The one that's hunting shows a working lamp. */}
      <nav aria-label="Kits" className="scroll-thin -mx-1 flex items-stretch gap-1.5 overflow-x-auto px-1 pb-1.5">
        {look.kits.map((k) => {
          const h = look.hunts.find((x) => x.kit === k.id);
          const tone: Tone = live(h) ? "busy" : h?.state === "done" && h.rented.length ? "ready" : h?.state === "failed" ? "problem" : "off";
          return (
            <button
              key={k.id}
              type="button"
              aria-current={k.id === sel ? "true" : undefined}
              onClick={() => pick(k.id)}
              className={cn("press squircle relative flex h-[52px] shrink-0 items-center gap-2.5 rounded-[14px] px-3.5 text-left", k.id === sel ? "bg-white/[0.09] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" : "hover:bg-white/[0.05]")}
            >
              <Lamp tone={tone} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className={cn("max-w-[190px] truncate font-display text-[13.5px] uppercase tracking-[0.01em]", k.id === sel ? "text-paper" : "text-fog")}>{(k.id === sel ? draft?.name : k.name) || "Kit"}</span>
                <span className="max-w-[190px] truncate text-[11px] text-haze">{live(h) ? "Hunting" : kitLine(k.id === sel && draft ? draft : k)}</span>
              </span>
              {k.id === sel ? <Tape /> : null}
            </button>
          );
        })}
        <button type="button" onClick={() => void add()} className="press squircle flex h-[52px] shrink-0 items-center gap-1.5 rounded-[14px] px-3.5 text-[12.5px] font-semibold text-haze hover:bg-white/[0.05] hover:text-paper">
          <Plus size={14} /> New kit
        </button>
      </nav>

      {said ? <p className="text-[13px] text-tally">{said}</p> : null}

      {draft ? (
        <>
          <section className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <input
              value={draft.name}
              disabled={locked}
              onChange={(e) => change({ name: e.target.value.slice(0, 40) })}
              aria-label="Kit name"
              placeholder="Name this kit"
              className="h-11 min-w-0 flex-1 rounded-[13px] bg-white/[0.04] px-3.5 font-display text-[19px] uppercase tracking-[0.01em] text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)] sm:max-w-[360px]"
            />
            {draft.gpus.length && offers ? (
              <a href="#rent-market" className="flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 text-[12.5px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:text-paper">
                <Lamp tone={offers.fits.length ? "ready" : "off"} />
                {offers.fits.length ? `${offers.fits.length} fit now · from ${money(Math.min(...offers.fits.map((o) => o.price)))}/h` : `Nothing fits now${offers.near.length ? ` · ${offers.near.length} close` : ""}`}
              </a>
            ) : null}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {locked ? (
                <Button variant="outline" onClick={() => void act({ action: "stop", id: draft.id })}>
                  <Square size={13} /> Stop
                </Button>
              ) : (
                <>
                  <ConfirmButton look="text" confirm="Delete this kit" onConfirm={remove} className="text-[12.5px] font-semibold text-haze hover:text-paper">
                    Delete
                  </ConfirmButton>
                  <Button variant="ghost" disabled={!draft.gpus.length || !look.key} onClick={() => void act({ action: "start", id: draft.id, dry: true })} title="Looks for a fit and says what it would rent. Rents nothing.">
                    <FlaskConical size={14} /> Test run
                  </Button>
                  <StartHunt kit={draft} disabled={!draft.gpus.length || !look.key} onStart={() => void act({ action: "start", id: draft.id })} />
                </>
              )}
            </span>
          </section>

          {hunt ? <HuntCard hunt={hunt} kit={draft} onDismiss={() => void act({ action: "dismiss", id: draft.id })} /> : null}

          <RentKitEditor kit={draft} market={market.length ? market : KNOWN_GPUS} unread={!market.length} locked={locked} onChange={change} />

          <Market
            kit={draft}
            offers={offers}
            problem={until ? null : lookSaid}
            closeBusy={closeBusy}
            onClose={until ? null : () => void seeClose()}
            canRent={!locked && Boolean(look.key)}
            onRent={(o) => void act({ action: "rent", id: draft.id, offer: o.id })}
            onBlock={(o, reason) => void act({ action: "block", machine: o.machine, host: o.host, gpu: o.gpu, place: o.place, reason })}
          />
        </>
      ) : (
        <div className="squircle rounded-[18px] bg-white/[0.025] px-6 py-10 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Radar size={26} className="mx-auto text-haze" />
          <p className="mt-3 text-[15px] font-semibold text-paper">No kit yet</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-haze">A kit is your wish list: the cards, the price, the disk. Make one, then switch it on whenever you need a box.</p>
          <Button variant="primary" className="mt-5" onClick={() => void add()}>
            <Plus size={14} /> New kit
          </Button>
        </div>
      )}

      <Blacklist blocked={look.blocked} boxes={boxes} onUnblock={(machine) => void act({ action: "unblock", machine })} onBlock={(b, reason) => void act({ action: "block", machine: b.machine, host: b.host, gpu: b.gpu, place: b.place ?? undefined, reason })} />
    </div>
  );
}

/* ------------------------------------------------------------------ the hunt */

/** Switching a hunt on spends money while you're away, so the second click says exactly what it will do. */
function StartHunt({ kit, disabled, onStart }: { kit: RentKit; disabled: boolean; onStart: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 8000);
    return () => clearTimeout(t);
  }, [asking]);
  if (!asking) {
    return (
      <Button variant="primary" disabled={disabled} onClick={() => setAsking(true)}>
        <Radar size={15} /> Hunt
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" role="group" aria-label="Start the hunt?">
      <Button variant="ghost" autoFocus onClick={() => setAsking(false)}>
        Not now
      </Button>
      <Button
        variant="primary"
        onClick={() => {
          setAsking(false);
          onStart();
        }}
      >
        Rent {kit.boxes === 1 ? "one box" : `${kit.boxes} boxes`} at {money(kit.maxPrice)}/h or less
      </Button>
    </span>
  );
}

const TAG: Record<FeedKind, { word: string; tone: string }> = {
  hunt: { word: "Hunting", tone: "text-daylight" },
  found: { word: "Found", tone: "text-chroma" },
  missed: { word: "Missed", tone: "text-tungsten" },
  rented: { word: "Rented", tone: "text-spike" },
  boot: { word: "Starting", tone: "text-daylight" },
  ready: { word: "Ready", tone: "text-chroma" },
  failed: { word: "Failed", tone: "text-tally" },
  stopped: { word: "Stopped", tone: "text-fog" },
  info: { word: "Note", tone: "text-haze" },
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

function HuntCard({ hunt, kit, onDismiss }: { hunt: Hunt; kit: RentKit; onDismiss: () => void }) {
  const on = live(hunt);
  const tone: Tone = on ? "busy" : hunt.state === "failed" ? "problem" : hunt.rented.length ? "ready" : "off";
  const head =
    hunt.state === "hunting"
      ? `${hunt.dry ? "Test run" : "Hunting"} · ${hunt.looks} ${hunt.looks === 1 ? "look" : "looks"} · ${hunt.fits ? `${hunt.fits} fit now` : "nothing fits yet"}`
      : hunt.state === "renting"
        ? "Renting…"
        : hunt.state === "starting"
          ? "Rented. Waiting for it to start…"
          : (hunt.why ?? "Ended");
  // Time left before the hunt gives up by itself, as a thin line.
  const total = Math.max(1, hunt.endsAt - hunt.startedAt);
  const left = Math.max(0, Math.min(1, (hunt.endsAt - (hunt.feed.at(-1)?.at ?? hunt.startedAt)) / total));
  return (
    <section className="squircle overflow-hidden rounded-[18px] bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)]" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3.5">
        <Lamp tone={tone} />
        <p className="text-[14px] font-semibold text-paper">{head}</p>
        {on && hunt.state === "hunting" ? <span className="text-[12px] text-haze">gives up by itself after {kit.hours} h</span> : null}
        {!on ? (
          <button type="button" onClick={onDismiss} className="ml-auto text-[12.5px] font-semibold text-haze hover:text-paper">
            Clear
          </button>
        ) : null}
      </div>
      {on && hunt.state === "hunting" ? (
        <span className="mx-4 mt-2.5 block h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
          <span className="block h-full origin-left rounded-full bg-daylight/70 transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${left})` }} />
        </span>
      ) : null}
      {hunt.rented.length ? (
        <ul className="mt-3 divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
          {hunt.rented.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
              <Lamp tone={r.ready ? "ready" : "busy"} />
              <span className="font-display text-[13.5px] uppercase text-paper">{r.gpu}</span>
              <span className="tabular-nums text-fog">{money(r.price)}/h</span>
              <span className="text-haze">{r.place}</span>
              <span className="text-haze">{r.ready ? `Running · stops after ${kit.idleStopMin} idle min` : "Starting…"}</span>
              <ButtonLink href="/settings/machines" size="sm" variant="ghost" className="ml-auto">
                Machines
              </ButtonLink>
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="scroll-thin mt-3 max-h-[168px] space-y-1 overflow-y-auto border-t border-[var(--color-line)] px-4 py-3 text-[12.5px] leading-snug">
        {[...hunt.feed].reverse().map((f, i) => (
          <li key={`${f.at}-${i}`} className="flex gap-2.5">
            <time className="shrink-0 tabular-nums text-haze">{clock(f.at)}</time>
            <span className={cn("w-[58px] shrink-0 font-semibold", TAG[f.kind].tone)}>{TAG[f.kind].word}</span>
            <span className="min-w-0 text-fog">{f.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ the market */

const HOST_TONE: Record<RentOffer["verification"], Tone> = { verified: "ready", unverified: "off", deverified: "needs" };

function Market({ kit, offers, problem, closeBusy, onClose, canRent, onRent, onBlock }: { kit: RentKit; offers: Offers | null; problem: string | null; closeBusy: boolean; onClose: (() => void) | null; canRent: boolean; onRent: (o: RentOffer) => void; onBlock: (o: RentOffer, reason: string) => void }) {
  const [all, setAll] = useState(false);
  const near = offers?.near ?? [];
  const shown = all ? near : near.slice(0, 5);
  return (
    <section id="rent-market" className="scroll-mt-6 space-y-3">
      <Heading
        title="On the market now"
        note={
          !kit.gpus.length
            ? "Pick a card to see what's on offer."
            : problem
              ? problem
              : !onClose && !offers
                ? "Waiting for vast.ai."
                : !offers
                  ? "Looking…"
              : `${offers.fits.length ? `${offers.fits.length} ${offers.fits.length === 1 ? "fits" : "fit"}` : "Nothing fits right now"}${near.length ? ` · ${near.length} close` : ""}. Checked every 30 seconds.`
        }
        aside={
          kit.gpus.length && onClose ? (
            <Button size="sm" variant="ghost" disabled={closeBusy} onClick={onClose} title="One wider search: the boxes just outside your limits, each with why">
              {closeBusy ? "Looking…" : near.length ? "Look again" : "See what's close"}
            </Button>
          ) : null
        }
      />
      {offers && (offers.fits.length || near.length) ? (
        <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[16px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
          {offers.fits.map((o) => (
            <OfferRow key={o.id} o={o} fit canRent={canRent} onRent={onRent} onBlock={onBlock} />
          ))}
          {shown.map((o) => (
            <OfferRow key={o.id} o={o} fit={false} canRent={false} onRent={onRent} onBlock={onBlock} />
          ))}
        </ul>
      ) : null}
      {near.length > 5 ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-[12.5px] font-semibold text-haze hover:text-paper">
          {all ? "Show fewer" : `Show all ${near.length} close ones`}
        </button>
      ) : null}
    </section>
  );
}

function OfferRow({ o, fit, canRent, onRent, onBlock }: { o: RentOffer; fit: boolean; canRent: boolean; onRent: (o: RentOffer) => void; onBlock: (o: RentOffer, reason: string) => void }) {
  const [blocking, setBlocking] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <li className={cn("px-4 py-2.5", !fit && "opacity-[0.62]")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
        <span className="flex w-[150px] shrink-0 flex-col leading-tight">
          <span className="font-display text-[14px] uppercase tracking-[0.01em] text-paper">{o.gpu}</span>
          <span className="text-[11px] text-haze">{o.gpuGb} GB · {o.ramGb} GB RAM</span>
        </span>
        <span className="w-[78px] shrink-0 font-display text-[17px] tabular-nums text-paper">
          {money(o.price)}
          <span className="text-[11px] text-haze">/h</span>
        </span>
        <span className="flex w-[150px] shrink-0 items-center gap-1.5 truncate text-fog" title={o.place}>
          <span className="rounded-[6px] bg-white/[0.07] px-1.5 py-0.5 text-[10.5px] font-bold tracking-[0.04em] text-paper">{o.country || "??"}</span>
          <span className="truncate">{o.place.replace(/,?\s*[A-Z]{2}$/, "").replace(/^,\s*/, "") || o.country}</span>
        </span>
        <span className="w-[112px] shrink-0 tabular-nums text-fog">
          ↓{o.down} ↑{o.up}
        </span>
        <span className="w-[70px] shrink-0 tabular-nums text-fog">${o.tbCost.toFixed(2)}/TB</span>
        <span className="flex w-[118px] shrink-0 items-center gap-1.5 text-fog">
          <Lamp tone={HOST_TONE[o.verification]} />
          <span className="capitalize">{o.verification}</span>
          {o.reliability ? <span className="tabular-nums text-haze">{Math.floor(o.reliability * 100)}%</span> : null}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => setBlocking((v) => !v)} title="Never rent this machine" aria-label="Never rent this machine" className="press grid size-8 place-items-center rounded-[10px] text-haze hover:bg-white/[0.06] hover:text-paper">
            <Ban size={14} />
          </button>
          {fit ? (
            <ConfirmButton confirm={`Rent at ${money(o.price)}/h`} onConfirm={() => onRent(o)} disabled={!canRent}>
              Rent
            </ConfirmButton>
          ) : null}
        </span>
      </div>
      {!fit && (o.misses.length || o.blocked) ? (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {o.blocked ? <span className="rounded-full bg-tally/[0.12] px-2 py-0.5 text-[11px] font-semibold text-tally">On your blacklist</span> : null}
          {o.misses.map((m) => (
            <span key={m} className="rounded-full bg-tungsten/[0.1] px-2 py-0.5 text-[11px] font-semibold text-tungsten">
              {m}
            </span>
          ))}
        </p>
      ) : null}
      {blocking ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onBlock(o, why.trim() || "Blocked by you");
            setBlocking(false);
            setWhy("");
          }}
        >
          <input autoFocus value={why} onChange={(e) => setWhy(e.target.value.slice(0, 200))} placeholder="Why? (say, OCI error on start)" aria-label="Why this machine is blocked" className="h-9 min-w-0 flex-1 rounded-[11px] bg-white/[0.05] px-3 text-[13px] text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:text-haze sm:max-w-[360px]" />
          <Button size="sm" variant="outline" type="submit">
            Never rent it
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setBlocking(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ the blacklist */

function Blacklist({ blocked, boxes, onUnblock, onBlock }: { blocked: Blocked[]; boxes: RentedNow[]; onUnblock: (machine: number) => void; onBlock: (b: { machine: number; host: number | null; gpu: string; place: string | null }, reason: string) => void }) {
  const [all, setAll] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const shown = all ? blocked : blocked.slice(0, 5);
  // Your own boxes whose machine isn't blocked yet: a box that never worked goes on the list from here.
  const mine = boxes.filter((b) => b.machine != null && !blocked.some((x) => x.machine === b.machine));
  return (
    <section className="space-y-3">
      <Heading title="Blacklist" note="Machines never rented again. A box that fails to start goes here by itself." />
      {blocked.length ? (
        <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[16px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
          {shown.map((b) => (
            <li key={b.machine} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
              <Ban size={13} className="shrink-0 text-haze" />
              <span className="font-semibold tabular-nums text-paper">#{b.machine}</span>
              {b.gpu ? <span className="font-display text-[12.5px] uppercase text-fog">{b.gpu}</span> : null}
              {b.place ? <span className="text-haze">{b.place}</span> : null}
              <span className="min-w-0 flex-1 basis-[240px] truncate text-fog" title={b.reason}>
                {b.reason}
              </span>
              <span className="text-[11.5px] text-haze">{b.auto ? "by Crackio" : "by you"}</span>
              <ConfirmButton look="text" confirm="Rent it again" onConfirm={() => onUnblock(b.machine)} className="text-[12.5px] font-semibold text-haze hover:text-paper">
                Unblock
              </ConfirmButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-haze">Nothing blocked yet.</p>
      )}
      {blocked.length > 5 ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-[12.5px] font-semibold text-haze hover:text-paper">
          {all ? "Show fewer" : `Show all ${blocked.length}`}
        </button>
      ) : null}
      {mine.length ? (
        <div className="pt-2">
          <p className="mb-2 text-[12.5px] text-haze">Your boxes on vast.ai. One that never worked? Block its machine.</p>
          <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[16px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
            {mine.map((b) => (
              <li key={b.id} className="px-4 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Lamp tone={b.state === "running" ? "ready" : "off"} />
                  <span className="font-display text-[13px] uppercase text-paper">{b.gpu || "GPU"}</span>
                  <span className="text-haze">{b.label}</span>
                  {b.place ? <span className="text-haze">{b.place}</span> : null}
                  <span className="capitalize text-fog">{b.state}</span>
                  <button type="button" onClick={() => (setAsking(asking === b.id ? null : b.id), setWhy(""))} className="ml-auto text-[12.5px] font-semibold text-haze hover:text-paper">
                    Block its machine
                  </button>
                </div>
                {asking === b.id ? (
                  <form
                    className="mt-2 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      onBlock({ machine: b.machine!, host: b.host, gpu: b.gpu, place: b.place }, why.trim() || "Blocked by you");
                      setAsking(null);
                    }}
                  >
                    <input autoFocus value={why} onChange={(e) => setWhy(e.target.value.slice(0, 200))} placeholder="Why? (say, it never started)" aria-label="Why this machine is blocked" className="h-9 min-w-0 flex-1 rounded-[11px] bg-white/[0.05] px-3 text-[13px] text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:text-haze sm:max-w-[360px]" />
                    <Button size="sm" variant="outline" type="submit">
                      Never rent it
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
