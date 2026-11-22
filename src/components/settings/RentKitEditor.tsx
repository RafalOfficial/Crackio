"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { GPU_GROUPS, RENT_LIMITS, type MarketGpu, type RentKit, type Verification } from "@/lib/rent/types";
import { Heading } from "./parts";

/**
 * A kit's two halves: the cards it may rent (picked from what's on the market now, with how many and from what price),
 * and its limits (price, disk, speed, hosts) plus what happens when it rents (how many, the idle stop, when it gives
 * up). Every change goes up at once; the page saves it.
 */
export function RentKitEditor({ kit, market, unread = false, locked, onChange }: { kit: RentKit; market: MarketGpu[]; /** The market hasn't been read: `market` is the list of well-known cards, with no prices. */ unread?: boolean; locked: boolean; onChange: (patch: Partial<RentKit>) => void }) {
  return (
    <div className={cn("grid gap-x-10 gap-y-9 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]", locked && "pointer-events-none opacity-55")} aria-disabled={locked}>
      <Cards kit={kit} market={market} unread={unread} onChange={onChange} />
      <div className="space-y-9">
        <Limits kit={kit} onChange={onChange} />
        <Rails kit={kit} onChange={onChange} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ cards */

const price = (n: number) => `$${n.toFixed(2)}`;
/** The cards shown before "All cards": the ones with enough memory for today's models. */
const BIG_GB = 20;

function Cards({ kit, market, unread, onChange }: { kit: RentKit; market: MarketGpu[]; unread: boolean; onChange: (patch: Partial<RentKit>) => void }) {
  const [find, setFind] = useState("");
  const [every, setEvery] = useState(false);
  const groups = useMemo(() => {
    // What's on the market now, plus the kit's own picks that aren't (a 5090 nobody offers this minute stays picked).
    const all = [...market, ...kit.gpus.filter((g) => !market.some((m) => m.name === g)).map((name) => ({ name, gb: 0, count: 0, from: 0 }))];
    const q = find.trim().toLowerCase();
    // A search looks through every card; otherwise the big ones and your picks, until "All cards".
    const shown = q ? all.filter((g) => g.name.toLowerCase().includes(q)) : every ? all : all.filter((g) => g.gb >= BIG_GB || kit.gpus.includes(g.name));
    const out = GPU_GROUPS.map((group) => ({ title: group.title, cards: shown.filter((g) => group.match.test(g.name)) }));
    const rest = shown.filter((g) => !GPU_GROUPS.some((group) => group.match.test(g.name)));
    // Big cards first inside a group: the ones people come here for.
    // (A pick nobody offers this minute has no size here: it leads its group.)
    const size = (g: MarketGpu) => g.gb || 999;
    return [...out, { title: "Other", cards: rest }].map((g) => ({ ...g, cards: g.cards.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name)) })).filter((g) => g.cards.length);
  }, [market, kit.gpus, find, every]);
  const small = market.filter((g) => g.gb < BIG_GB && !kit.gpus.includes(g.name)).length;
  const toggle = (name: string) => onChange({ gpus: kit.gpus.includes(name) ? kit.gpus.filter((g) => g !== name) : [...kit.gpus, name] });

  return (
    <section className="min-w-0 space-y-4">
      <Heading
        title="Cards"
        note={kit.gpus.length ? `${kit.gpus.length} picked. Any of them will do.` : "Pick the cards this kit may rent."}
        aside={
          <label className="flex h-9 w-[190px] items-center gap-2 rounded-[11px] bg-white/[0.04] px-3 text-[13px] shadow-[inset_0_0_0_1px_var(--color-line)] focus-within:shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
            <Search size={14} className="shrink-0 text-haze" />
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a card" aria-label="Find a card" className="min-w-0 flex-1 bg-transparent text-paper outline-none placeholder:text-haze" />
            {find ? (
              <button type="button" onClick={() => setFind("")} aria-label="Clear" className="text-haze hover:text-paper">
                <X size={13} />
              </button>
            ) : null}
          </label>
        }
      />
      {groups.map((g) => (
        <div key={g.title}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-haze">{g.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {g.cards.map((c) => {
              const on = kit.gpus.includes(c.name);
              return (
                <button
                  key={c.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.name)}
                  title={unread ? c.name : c.count ? `${c.count} on offer, from ${price(c.from)} an hour` : "None on offer when the market was last read"}
                  className={cn(
                    "press squircle flex h-[46px] items-center gap-2.5 rounded-[13px] px-3 text-left transition-colors",
                    on ? "bg-spike/[0.14] shadow-[inset_0_0_0_1.5px_var(--color-spike)]" : "bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06]",
                    !c.count && !on && !unread && "opacity-50",
                  )}
                >
                  <span className="flex flex-col leading-tight">
                    <span className={cn("font-display text-[13px] uppercase tracking-[0.01em]", on ? "text-paper" : "text-fog")}>{c.name}</span>
                    <span className="text-[11px] text-haze">
                      {c.gb ? `${c.gb} GB` : ""}
                      {unread ? "" : c.count ? `${c.gb ? " · " : ""}from ${price(c.from)}` : `${c.gb ? " · " : ""}none now`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!groups.length ? <p className="text-[13px] text-haze">{market.length ? "No card by that name." : "Reading the market…"}</p> : null}
      {small && !find.trim() ? (
        <button type="button" onClick={() => setEvery((v) => !v)} className="text-[12.5px] font-semibold text-haze hover:text-paper">
          {every ? `Only cards with ${BIG_GB} GB or more` : `All cards (${small} smaller ones)`}
        </button>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ limits */

/** A row: what it limits on the left, its control on the right. */
function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-paper">{label}</p>
        {note ? <p className="text-[12px] text-haze">{note}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div>
    </div>
  );
}

/** A number you type, with its unit. Empty means "any" where that's allowed. */
function Num({ value, onChange, unit, before, min, max, step = 1, any, label, width = 76 }: { value: number | null; onChange: (v: number | null) => void; unit?: string; before?: string; min: number; max: number; step?: number; any?: boolean; label: string; width?: number }) {
  // What's typed is kept as typed until it's a number: "0." mustn't snap back to 0 mid-word.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value == null ? "" : String(value));
  return (
    <label className="flex h-9 items-center gap-1 rounded-[11px] bg-white/[0.04] px-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--color-line)] focus-within:shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
      {before ? <span className="text-haze">{before}</span> : null}
      <input
        inputMode="decimal"
        aria-label={label}
        value={shown}
        placeholder={any ? "Any" : ""}
        style={{ width }}
        onChange={(e) => {
          const t = e.target.value.replace(",", ".");
          setText(t);
          if (!t.trim()) return any ? onChange(null) : undefined;
          const n = Number(t);
          if (Number.isFinite(n) && n >= min && n <= max) onChange(Math.round(n / step) * step);
        }}
        onBlur={() => setText(null)}
        className="min-w-0 bg-transparent text-right font-semibold tabular-nums text-paper outline-none placeholder:font-normal placeholder:text-haze"
      />
      {unit ? <span className="text-haze">{unit}</span> : null}
    </label>
  );
}

/** Small picks in a row: one of them, or several. */
function Chips<T extends string | number>({ options, value, onPick, label }: { options: { value: T; label: string }[]; value: T | T[]; onPick: (v: T) => void; label: string }) {
  const on = (v: T) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <div role="group" aria-label={label} className="flex flex-wrap justify-end gap-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={on(o.value)}
          onClick={() => onPick(o.value)}
          className={cn("press h-9 rounded-[11px] px-3 text-[12.5px] font-semibold transition-colors", on(o.value) ? "bg-white/[0.12] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" : "bg-white/[0.03] text-fog shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.06] hover:text-paper")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const HOSTS: { value: Verification; label: string }[] = [
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Unverified" },
  { value: "deverified", label: "Deverified" },
];

function Limits({ kit, onChange }: { kit: RentKit; onChange: (patch: Partial<RentKit>) => void }) {
  const [country, setCountry] = useState("");
  const addCountry = () => {
    const code = country.trim().toUpperCase().slice(0, 2);
    if (/^[A-Z]{2}$/.test(code) && !kit.skipCountries.includes(code)) onChange({ skipCountries: [...kit.skipCountries, code] });
    setCountry("");
  };
  return (
    <section className="space-y-1">
      <Heading title="Limits" note="A box has to meet every one." />
      <div className="divide-y divide-[var(--color-line)]">
        <Row label="Price" note="An hour, with the disk. A hard cap.">
          <input
            type="range"
            aria-label="Price cap"
            min={0.05}
            max={3}
            step={0.01}
            value={Math.min(3, kit.maxPrice)}
            onChange={(e) => onChange({ maxPrice: Number(e.target.value) })}
            className="h-1 w-[120px] cursor-pointer appearance-none rounded-full bg-white/[0.12] accent-[var(--color-spike)]"
          />
          <Num label="Price cap, dollars an hour" value={kit.maxPrice} onChange={(v) => v != null && onChange({ maxPrice: v })} before="$" unit="/h" min={RENT_LIMITS.price[0]} max={RENT_LIMITS.price[1]} step={0.001} width={52} />
        </Row>
        <Row label="Disk">
          <Chips label="Disk" options={[60, 120, 200, 400].map((v) => ({ value: v, label: `${v}` }))} value={kit.diskGb} onPick={(v) => onChange({ diskGb: v })} />
          <Num label="Disk, GB" value={kit.diskGb} onChange={(v) => v != null && onChange({ diskGb: v })} unit="GB" min={RENT_LIMITS.disk[0]} max={RENT_LIMITS.disk[1]} width={44} />
        </Row>
        <Row label="Memory" note="System RAM, at least.">
          <Num label="Memory, GB at least" value={kit.minRamGb} onChange={(v) => onChange({ minRamGb: v })} unit="GB" min={1} max={4096} any width={44} />
        </Row>
        <Row label="Internet" note="Down and up, at least.">
          <Num label="Download, Mb/s at least" value={kit.minDown} onChange={(v) => onChange({ minDown: v })} before="↓" unit="Mb/s" min={1} max={100000} any width={48} />
          <Num label="Upload, Mb/s at least" value={kit.minUp} onChange={(v) => onChange({ minUp: v })} before="↑" unit="Mb/s" min={1} max={100000} any width={48} />
        </Row>
        <Row label="Data" note="What moving a terabyte costs, at most.">
          <Num label="Dollars per terabyte at most" value={kit.maxTbCost} onChange={(v) => onChange({ maxTbCost: v })} before="$" unit="/TB" min={0.01} max={1000} step={0.01} any width={48} />
        </Row>
        <Row label="Hosts" note="Deverified hosts failed vast.ai's checks.">
          <Chips label="Hosts" options={HOSTS} value={kit.verification} onPick={(v) => onChange({ verification: kit.verification.includes(v) ? (kit.verification.length > 1 ? kit.verification.filter((x) => x !== v) : kit.verification) : [...kit.verification, v] })} />
        </Row>
        <Row label="Reliable" note="Share of time the host was up.">
          <Chips
            label="Reliability at least"
            options={[
              { value: 0, label: "Any" },
              { value: 0.95, label: "95%" },
              { value: 0.98, label: "98%" },
              { value: 0.99, label: "99%" },
            ]}
            value={kit.minReliability ?? 0}
            onPick={(v) => onChange({ minReliability: v || null })}
          />
        </Row>
        <Row label="Never in" note="Countries to skip, by two-letter code.">
          {kit.skipCountries.map((c) => (
            <button key={c} type="button" onClick={() => onChange({ skipCountries: kit.skipCountries.filter((x) => x !== c) })} title={`Rent in ${c} again`} className="press flex h-9 items-center gap-1 rounded-[11px] bg-white/[0.08] px-2.5 text-[12.5px] font-semibold text-paper hover:bg-white/[0.12]">
              {c} <X size={12} className="text-haze" />
            </button>
          ))}
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCountry()}
            onBlur={addCountry}
            placeholder="CN"
            maxLength={2}
            aria-label="Add a country to skip"
            className="h-9 w-[52px] rounded-[11px] bg-white/[0.04] px-2.5 text-center text-[13px] font-semibold uppercase text-paper shadow-[inset_0_0_0_1px_var(--color-line)] outline-none placeholder:font-normal placeholder:text-haze focus:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
          />
        </Row>
        <Row label="Take first">
          <Chips
            label="Take first"
            options={[
              { value: "cheapest", label: "The cheapest" },
              { value: "reliable", label: "The most reliable" },
            ]}
            value={kit.order}
            onPick={(v) => onChange({ order: v as RentKit["order"] })}
          />
        </Row>
      </div>
    </section>
  );
}

function Rails({ kit, onChange }: { kit: RentKit; onChange: (patch: Partial<RentKit>) => void }) {
  return (
    <section className="space-y-1">
      <Heading title="When it rents" note="So a hunt never costs more than you meant." />
      <div className="divide-y divide-[var(--color-line)]">
        <Row label="Starts with" note={kit.template === "pytorch" ? "Also hosts with older drivers. Crackio installs ComfyUI there, a few minutes more." : "vast.ai's ComfyUI image: ready sooner."}>
          <Chips
            label="Starts with"
            options={[
              { value: "comfyui", label: "ComfyUI" },
              { value: "pytorch", label: "PyTorch" },
            ]}
            value={kit.template ?? "comfyui"}
            onPick={(v) => onChange({ template: v as RentKit["template"] })}
          />
        </Row>
        <Row label="Boxes" note="It rents this many, then stops.">
          <Chips label="Boxes" options={[1, 2, 3, 4].map((v) => ({ value: v, label: String(v) }))} value={kit.boxes} onPick={(v) => onChange({ boxes: v })} />
        </Row>
        <Row label="Idle stop" note="A rented box stops itself when it sits idle.">
          <Chips label="Idle stop" options={[15, 30, 45, 60, 120].map((v) => ({ value: v, label: v < 60 ? `${v}` : `${v / 60} h` }))} value={kit.idleStopMin} onPick={(v) => onChange({ idleStopMin: v })} />
          <Num label="Idle stop, minutes" value={kit.idleStopMin} onChange={(v) => v != null && onChange({ idleStopMin: v })} unit="min" min={RENT_LIMITS.idleStop[0]} max={RENT_LIMITS.idleStop[1]} width={40} />
        </Row>
        <Row label="Give up after" note="A hunt that finds nothing ends by itself.">
          <Chips label="Give up after" options={[1, 3, 6, 12].map((v) => ({ value: v, label: `${v} h` }))} value={kit.hours} onPick={(v) => onChange({ hours: v })} />
        </Row>
        <Row label="Keep in the account" note="It stops looking under this balance.">
          <Num label="Balance to keep, dollars" value={kit.minBalance} onChange={(v) => v != null && onChange({ minBalance: v })} before="$" min={RENT_LIMITS.minBalance[0]} max={RENT_LIMITS.minBalance[1]} step={0.5} width={44} />
        </Row>
      </div>
    </section>
  );
}
