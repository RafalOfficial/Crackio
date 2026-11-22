"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Check, Download, Heart, KeyRound, LoaderCircle, Play, Plus, Search, TriangleAlert, X } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { useLocalStore } from "@/lib/hooks/use-local";
import { addLora, browseLoras, loraAccess, searchOtherModels, loadLoraLibrary, loraDownloads, loraTargets, modelEntries, repoLoraInfo, useLoraLibrary, viewOf, type LoraAccess, type LoraSort, type LoraView, type RepoInfo } from "@/lib/hooks/use-lora-library";
import { MAX_LORAS, useModelLoras, type LoraPick } from "@/lib/hooks/use-model-loras";
import { useLorasOn } from "@/lib/hooks/use-loras-on";
import { autoTrigger, categoryLabel, LORA_CATEGORIES, type LoraBrowse, type LoraCategory, type LoraEntry, type LoraFile } from "@/lib/local/loras";
import { gb } from "@/lib/local/rows";
import type { LocalModel, LocalStatus, TargetStatus } from "@/lib/local/types";
import { cn } from "@/lib/cn";
import { bytesOf, count, Cover, LICENCE, Problem, Progress, usePeek, useToggle, YourLoras } from "./YourLoras";

/**
 * One model's LoRAs, as a shop window: every LoRA made for it, most popular first, each with an example of what it does
 * (a clip plays under the pointer), one button to add it (it downloads to your GPU and switches on) and its own page for
 * the rest (what it does, the words it adds, how strong, its licence). Crackio's checked picks and the LoRAs found on
 * Hugging Face whose example was looked at share one grid; typing searches all of Hugging Face for the model. "Yours"
 * holds what you have: on or off, how strong, your own uploads, which machine has which (components/loras/YourLoras).
 * What's switched on goes with every job the model runs, in every tool (hooks/use-model-loras).
 * The model library shows it when a card's LoRAs button is pressed; Settings → LoRAs for the model picked there.
 */

const EMPTY: LoraPick[] = [];
const NOTHING: LoraBrowse = { entries: [], counts: {} };
const SORTS: { id: LoraSort; label: string }[] = [
  { id: "downloads", label: "Most popular" },
  { id: "likes", label: "Most liked" },
  { id: "new", label: "Newest" },
];

/** A LoRA on the page: what it is, and what it is on your machines. */
type Item = { entry: LoraEntry; view: LoraView; downloads: number; likes: number };

export function ModelLoras({
  model,
  compact = false,
  initial = null,
  names,
  onElsewhere,
}: {
  model: LocalModel;
  compact?: boolean;
  /** A LoRA to open on arrival (picked from a search while another model was in view). */
  initial?: string | null;
  /** Every model's name by id, to say which model a LoRA found elsewhere is for. */
  names?: Record<string, string>;
  /** A LoRA of another model was picked from the search: go to that model and open it. */
  onElsewhere?: (entry: LoraEntry) => void;
}) {
  const status = useLocalStore((s) => s.status);
  const { library, error } = useLoraLibrary();
  useEffect(() => loadLoraLibrary(), []);
  const crackio = model.crackio ?? `local:${model.id}`;
  const picks = useModelLoras((s) => s.byModel[crackio]) ?? EMPTY;
  const { picks: checked, found: mine } = useMemo(() => modelEntries(library, model), [library, model]);
  const targets = loraTargets(status, model);

  const [tab, setTab] = useState<"browse" | "yours">("browse");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LoraSort>("downloads");
  const [category, setCategory] = useState<LoraCategory | "all">("all");
  const [open, setOpen] = useState<string | null>(initial);
  const page = compact ? 18 : 24;
  const [more, setMore] = useState(1);
  // The unchecked finds of a search come ten at a time: a wall of cards without pictures helps nobody.
  const [hub, setHub] = useState(1);

  // The model's listing on Hugging Face (what the library shows of it), and, while words are typed, what matches them.
  const words = query.trim();
  const [listed, setListed] = useState<{ key: string; value: LoraBrowse & { error?: string } } | null>(null);
  const [matched, setMatched] = useState<{ key: string; value: LoraBrowse & { error?: string } } | null>(null);
  const listKey = `${model.id}|${sort}`;
  const matchKey = `${model.id}|${sort}|${words.toLowerCase()}`;
  useEffect(() => {
    let live = true;
    void browseLoras(model, "", sort).then((value) => live && setListed({ key: `${model.id}|${sort}`, value }));
    return () => {
      live = false;
    };
  }, [model, sort]);
  useEffect(() => {
    if (!words) return;
    let live = true;
    const timer = setTimeout(() => void browseLoras(model, words, sort).then((value) => live && setMatched({ key: `${model.id}|${sort}|${words.toLowerCase()}`, value })), 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [model, sort, words]);
  // The same words among the other models' LoRAs: what you're after may be made for another model.
  const [elsewhere, setElsewhere] = useState<{ key: string; entries: LoraEntry[] } | null>(null);
  const seeksElsewhere = Boolean(onElsewhere) && words.length >= 2;
  useEffect(() => {
    if (!seeksElsewhere) return;
    let live = true;
    const timer = setTimeout(() => void searchOtherModels(words, model).then((entries) => live && setElsewhere({ key: `${model.id}|${words.toLowerCase()}`, entries })), 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [model, words, seeksElsewhere]);
  const other = seeksElsewhere && elsewhere?.key === `${model.id}|${words.toLowerCase()}` ? elsewhere.entries : [];
  const list = listed?.key === listKey ? listed.value : null;
  const match = words && matched?.key === matchKey ? matched.value : null;

  // Every LoRA of the model you have or could have: Crackio's picks, and the files downloaded for it (one entry each).
  const views = useMemo(() => [...checked, ...mine].map((e) => viewOf(e, status, model)), [checked, mine, status, model]);
  const onFiles = useMemo(() => new Set(picks.map((p) => p.file)), [picks]);
  const onNow = views.filter((v) => v.files.length > 0 && v.files.every((f) => onFiles.has(f)));
  const yours = views.filter((v) => v.installed.some((t) => t.id !== "comfy-cloud") || v.files.some((f) => onFiles.has(f)) || Boolean(v.entry.uploaded || v.entry.trained)).length;

  // The window: picks and finds together, in the order asked. A find you already downloaded stands with its files.
  const counts = list?.counts ?? NOTHING.counts;
  const items = useMemo(() => {
    const byRepo = new Map(mine.filter((e) => !e.uploaded && !e.trained).map((e) => [e.repo.toLowerCase(), e]));
    const itemOf = (entry: LoraEntry): Item => {
      const live = counts[entry.repo];
      const numbers = { downloads: live?.downloads ?? entry.downloads ?? 0, likes: live?.likes ?? entry.likes ?? 0 };
      if (!entry.found) return { entry, view: viewOf(entry, status, model), ...numbers };
      const have = byRepo.get(entry.repo.toLowerCase());
      // Not downloaded yet: it has no files here, so it's on no machine (an empty list would read as "on all of them").
      if (!have) return { entry, view: { entry, files: [], installed: [], missing: targets }, ...numbers };
      const merged: LoraEntry = { ...entry, files: have.files, local: have.local, strength: have.strength, range: have.range, ...(have.trigger ? { trigger: have.trigger } : {}), ...(have.triggerAt ? { triggerAt: have.triggerAt } : {}) };
      return { entry: merged, view: { ...viewOf(have, status, model), entry: merged }, ...numbers };
    };
    const shown = [...checked.map(itemOf), ...(list?.entries ?? []).map(itemOf)];
    const known = new Set(shown.map((x) => x.entry.repo.toLowerCase()));
    const extra = (match?.entries ?? []).filter((e) => !known.has(e.repo.toLowerCase())).map(itemOf);
    const order = (a: Item, b: Item) =>
      sort === "likes" ? b.likes - a.likes || b.downloads - a.downloads : sort === "new" ? (Date.parse(b.entry.created ?? "") || 0) - (Date.parse(a.entry.created ?? "") || 0) || b.downloads - a.downloads : b.downloads - a.downloads || b.likes - a.likes;
    return { shown: shown.sort(order), extra: extra.sort(order) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, mine, list, match, counts, status, model, sort]);

  const says = (x: Item) => `${x.entry.name} ${x.entry.blurb} ${x.entry.author} ${categoryLabel(x.entry.category)} ${x.entry.trigger ?? ""}`.toLowerCase();
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = terms.length ? items.shown.filter((x) => terms.every((t) => says(x).includes(t))) : items.shown;
  const kinds = LORA_CATEGORIES.filter((c) => hits.some((x) => x.entry.category === c.id) || items.extra.some((x) => x.entry.category === c.id));
  const kind = kinds.some((c) => c.id === category) ? category : "all";
  const inKind = (x: Item) => kind === "all" || x.entry.category === kind;
  const cards = hits.filter(inKind);
  const others = terms.length ? items.extra.filter(inKind) : [];
  const searching = Boolean(words) && !match;
  const loading = !library && !error;

  // A LoRA's own page: looked up among what's on the page now, so its state follows a download.
  const opened = open ? ([...items.shown, ...items.extra].find((x) => x.entry.id === open) ?? null) : null;
  const reset = () => (setMore(1), setHub(1));

  if (!model.crackio) return <p className="text-[13px] text-haze">Crackio can&rsquo;t run this model yet, so it takes no LoRAs.</p>;

  if (opened) {
    return (
      <div className="@container">
        <LoraPage item={opened} crackio={crackio} picks={picks} status={status} model={model} targets={targets} onBack={() => setOpen(null)} />
      </div>
    );
  }

  const tabs: { id: "browse" | "yours"; label: string; fact?: string }[] = [
    { id: "browse", label: "Browse" },
    { id: "yours", label: "Yours", fact: picks.length ? `${picks.length} on` : yours ? String(yours) : undefined },
  ];
  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-2">
        <label className="field-focus flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-full bg-white/[0.06] px-4">
          <Search size={15} className="shrink-0 text-haze" />
          <input
            type="search"
            value={query}
            onChange={(e) => (setQuery(e.target.value), setTab("browse"), reset())}
            placeholder={compact ? `Search LoRAs for ${model.name}` : "Search by what you want: anime, film grain, orbit, fire…"}
            aria-label={`Search LoRAs for ${model.name}`}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-paper outline-none placeholder:text-haze [&::-webkit-search-cancel-button]:hidden"
          />
          {searching ? <LoaderCircle size={14} className="shrink-0 animate-spin text-haze" /> : null}
          {query ? (
            <button type="button" onClick={() => (setQuery(""), reset())} aria-label="Clear the search" className="press shrink-0 text-haze hover:text-paper">
              <X size={15} />
            </button>
          ) : null}
        </label>
        <div className="flex shrink-0 rounded-full bg-white/[0.05] p-0.5 text-[13px]" role="tablist" aria-label="LoRAs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("press inline-flex h-9 items-center gap-1.5 rounded-full px-4 font-semibold", tab === t.id ? "bg-paper text-[#16131b]" : "text-fog hover:text-paper")}>
              {t.label}
              {t.fact ? <span className={cn("text-[11.5px] tabular-nums", tab === t.id ? "text-[#16131b]/60" : picks.length ? "text-chroma" : "text-haze")}>{t.fact}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {error && !library ? (
        <p className="mt-3 flex items-center gap-2 rounded-[12px] bg-tally/10 px-3.5 py-2.5 text-[13px] text-tally">
          <TriangleAlert size={14} /> Couldn&rsquo;t load the LoRA library: {error}
        </p>
      ) : null}

      {tab === "yours" ? (
        <div className="mt-5">
          <YourLoras model={model} views={views} picks={picks} status={status} targets={targets} />
        </div>
      ) : (
        <>
          {onNow.length ? <OnNow views={onNow} crackio={crackio} picks={picks} onOpen={(v) => (items.shown.some((x) => x.entry.id === v.entry.id) ? setOpen(v.entry.id) : setTab("yours"))} /> : null}

          <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
            {kinds.length > 1 ? (
              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group" aria-label="What they do">
                {[{ id: "all" as const, label: "All", hint: "" }, ...kinds].map((c) => (
                  <button key={c.id} type="button" onClick={() => (setCategory(c.id), reset())} aria-pressed={kind === c.id} title={c.hint || undefined} className={cn("press h-8 rounded-full px-3 text-[12.5px] font-semibold", kind === c.id ? "bg-white/[0.16] text-paper" : "bg-white/[0.045] text-fog hover:text-paper")}>
                    {c.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="flex-1" />
            )}
            <select value={sort} onChange={(e) => (setSort(e.target.value as LoraSort), reset())} aria-label="Order" className="h-8 shrink-0 rounded-full bg-white/[0.045] px-3 text-[12.5px] font-semibold text-fog outline-none hover:text-paper">
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {!targets.length && !loading ? <p className="mt-3 text-[12.5px] text-tungsten">Connect a GPU in Settings → Machines to add LoRAs.</p> : null}

          {loading ? (
            <Grid compact={compact}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skeleton aspect-[4/5] rounded-[18px]" />
              ))}
            </Grid>
          ) : cards.length ? (
            <>
              <Grid compact={compact}>
                {cards.slice(0, page * more).map((x) => (
                  <LoraCard key={x.entry.id} item={x} crackio={crackio} picks={picks} status={status} model={model} targets={targets} onOpen={() => setOpen(x.entry.id)} />
                ))}
              </Grid>
              {cards.length > page * more ? (
                <button type="button" onClick={() => setMore(more + 1)} className="press mx-auto mt-4 flex h-10 items-center rounded-full bg-white/[0.06] px-5 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
                  Show more <span className="ml-1.5 tabular-nums text-haze">{cards.length - page * more}</span>
                </button>
              ) : null}
            </>
          ) : !others.length && !searching ? (
            <p className="mt-4 rounded-[14px] bg-white/[0.025] px-4 py-3.5 text-[13px] leading-relaxed text-haze">
              {words ? (other.length ? `Nothing for ${model.name} matches “${words}”, but other models have it: see below.` : `Nothing for ${model.name} matches “${words}”. Try one plain word: a look (film, anime), a move (orbit, zoom) or an effect (explode, melt).`) : !list ? "Looking on Hugging Face…" : `No LoRAs for ${model.name} here yet: few exist for it so far. Search to look across Hugging Face, or upload your own under Yours.`}
            </p>
          ) : null}

          {list?.error || match?.error ? <Problem text={(match?.error ?? list?.error)!} /> : null}

          {others.length ? (
            <section className="mt-7" aria-label="More on Hugging Face">
              <h3 className="label">
                More on Hugging Face
                <span className="ml-2 font-medium normal-case tracking-normal text-haze/80">Not checked by Crackio: the pictures are their makers&rsquo; own</span>
              </h3>
              <Grid compact={compact}>
                {others.slice(0, 10 * hub).map((x) => (
                  <LoraCard key={x.entry.id} item={x} crackio={crackio} picks={picks} status={status} model={model} targets={targets} onOpen={() => setOpen(x.entry.id)} />
                ))}
              </Grid>
              {others.length > 10 * hub ? (
                <button type="button" onClick={() => setHub(hub + 1)} className="press mx-auto mt-4 flex h-10 items-center rounded-full bg-white/[0.06] px-5 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
                  Show more from Hugging Face <span className="ml-1.5 tabular-nums text-haze">{others.length - 10 * hub}</span>
                </button>
              ) : null}
            </section>
          ) : null}

          {other.length && onElsewhere ? (
            <section className="mt-7" aria-label="For other models">
              <h3 className="label">
                For other models
                <span className="ml-2 font-medium normal-case tracking-normal text-haze/80">Pick one to go to its model</span>
              </h3>
              <Grid compact={compact}>
                {other.slice(0, 12).map((entry) => (
                  <ElsewhereCard key={`${entry.id}|${entry.models[0]}`} entry={entry} names={names} onPick={() => onElsewhere(entry)} />
                ))}
              </Grid>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A LoRA made for another model, found by the search: its example, what it does, and the model it's for. */
function ElsewhereCard({ entry, names, onPick }: { entry: LoraEntry; names?: Record<string, string>; onPick: () => void }) {
  const [over, setOver] = useState(false);
  const made = entry.models.map((id) => names?.[id] ?? id);
  return (
    <button
      type="button"
      onClick={onPick}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      title={`Made for ${made.join(", ")}`}
      className="squircle press flex flex-col overflow-hidden rounded-[18px] bg-white/[0.035] text-left transition-colors hover:bg-white/[0.06]"
    >
      <span className="relative block aspect-[4/3] w-full overflow-hidden bg-white/[0.03]">
        <Cover entry={entry} play={over} />
        <span className="absolute left-2 top-2 max-w-[88%] truncate rounded-full bg-[#0d0c11]/75 px-2.5 py-1 text-[11px] font-semibold text-paper">
          {made[0]}
          {made.length > 1 ? ` +${made.length - 1}` : ""}
        </span>
      </span>
      <span className="flex flex-1 flex-col px-3 pb-3 pt-2.5">
        <span className="truncate text-[14px] font-semibold text-paper">{entry.name}</span>
        <span className="mt-0.5 line-clamp-2 min-h-[2.6em] text-[12px] leading-[1.3] text-haze">{entry.blurb || `${categoryLabel(entry.category)} · by ${entry.author}`}</span>
      </span>
    </button>
  );
}

function Grid({ compact, children }: { compact: boolean; children: ReactNode }) {
  // Two to a row on a phone (one card a screen made the list endless), as many as fit from there up.
  return <div className={cn("mt-3.5 grid grid-cols-2 gap-2.5 @min-[520px]:gap-3", compact ? "@min-[520px]:grid-cols-[repeat(auto-fill,minmax(172px,1fr))]" : "@min-[520px]:grid-cols-[repeat(auto-fill,minmax(212px,1fr))]")}>{children}</div>;
}

/** What's switched on for the model now: each by name, opened with a click, off with its ×. */
function OnNow({ views, crackio, picks, onOpen }: { views: LoraView[]; crackio: string; picks: LoraPick[]; onOpen: (v: LoraView) => void }) {
  const { set } = useToggle(crackio, picks);
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-1.5" aria-label="Switched on now">
      <span className="mr-1 text-[12px] font-semibold text-haze">On now</span>
      {views.map((v) => (
        <span key={v.entry.id} className="inline-flex h-8 items-center rounded-full bg-chroma/[0.13] pl-3 pr-1 text-[12.5px] font-semibold text-chroma">
          <button type="button" onClick={() => onOpen(v)} className="press max-w-[180px] truncate hover:underline" title="Its strength and details">
            {v.entry.name}
          </button>
          <button type="button" onClick={() => set(v.files, null)} aria-label={`Switch ${v.entry.name} off`} title="Switch off" className="press ml-1 grid size-6 place-items-center rounded-full hover:bg-chroma/20">
            <X size={12} strokeWidth={2.6} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * What a LoRA's one button does next, on a card and on its page alike: add it (download and switch on), follow its
 * download, switch it on or off.
 */
/**
 * Whether you may download a LoRA whose makers ask you to accept their terms on Hugging Face first: asked when the
 * LoRA comes on screen, and again each time this window comes back to the front (you were just there, accepting them).
 * null: not asked, or no answer yet.
 */
function useAccess(entry: LoraEntry, wanted: boolean): { access: LoraAccess | null; again: () => void } {
  const [got, setGot] = useState<{ repo: string; access: LoraAccess | null } | null>(null);
  const ask = useCallback(
    (again: boolean) => {
      void loraAccess(entry, again).then((access) => setGot({ repo: entry.repo, access }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry.repo],
  );
  useEffect(() => {
    if (!wanted) return;
    ask(false);
    const back = () => document.visibilityState === "visible" && ask(true);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [wanted, ask]);
  return { access: wanted && got?.repo === entry.repo ? got.access : null, again: () => ask(true) };
}

function useLoraAction({ item, crackio, picks, status, model, targets }: { item: Item; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; targets: TargetStatus[] }) {
  const { entry, view } = item;
  const files = view.files;
  const on = files.length > 0 && files.every((f) => picks.some((p) => p.file === f));
  const downloads = loraDownloads(status, files);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { set, full } = useToggle(crackio, picks);
  // "You have it" is said of the machine your jobs run on: the one picked under Run on, else every free machine with the
  // model. On another machine only (seen Nov 2026: a file left on a pay-per-job endpoint, a GPU connected that day), the
  // card read On, nothing was downloaded, and the picture was drawn without the LoRA.
  const picked = targets.find((t) => t.id === status?.runOn);
  const lacking = view.missing.filter((t) => (picked ? t.id === picked.id : !t.metered));
  const ready = files.length > 0 && view.installed.length > 0 && lacking.length === 0;
  const needsToken = Boolean(entry.gated) && !status?.hfToken;
  // One whose makers ask for their terms first, not here yet: is that done on your Hugging Face account?
  const gate = useAccess(entry, Boolean(entry.gated) && Boolean(status?.hfToken) && !ready);
  async function add(file?: LoraFile) {
    setWorking(true);
    setProblem(null);
    setProblem(await addLora(model, entry, view.missing.length ? view.missing : targets, file));
    setWorking(false);
  }
  const state: "downloading" | "on" | "off" | "no-gpu" | "token" | "terms" | "asking" | "add" = downloads.active.length
    ? "downloading"
    : ready && on
      ? "on"
      : ready
        ? "off"
        : !targets.length
          ? "no-gpu"
          : needsToken || gate.access === "no-token"
            ? "token"
            : entry.gated && gate.access === "needed"
              ? "terms"
              : entry.gated && gate.access === null
                ? "asking"
                : "add";
  // Hugging Face refusing a gated LoRA though your token is set: its terms aren't accepted yet (seen on a rented box, Nov 2026).
  const said = problem ?? downloads.failed?.error ?? null;
  const plain = said && /\b40[13]\b|gated/i.test(said) ? "Hugging Face won't hand this one over yet: open its page there, accept its terms with your account, then press Add again." : said;
  // While its terms are still to accept, an earlier refusal says nothing new: the button and its line say it.
  const waits = state === "terms" || state === "token" || state === "asking";
  // On a machine of yours already, but not where your jobs run: the button says where it goes.
  const goesTo = view.installed.length && lacking.length ? lacking.map((t) => t.label).join(", ") : null;
  return { state, gate, on, files, downloads, working, problem: waits ? null : plain, full, add, goesTo, turn: (to: boolean) => set(files, to ? entry.strength : null), strength: (v: number) => set(files, v) };
}

function LoraCard({ item, crackio, picks, status, model, targets, onOpen }: { item: Item; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; targets: TargetStatus[]; onOpen: () => void }) {
  const { entry } = item;
  const act = useLoraAction({ item, crackio, picks, status, model, targets });
  const [over, setOver] = useState(false);
  const peek = usePeek(entry);
  const pill = "press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold";
  let action: ReactNode;
  if (act.state === "downloading") action = <span className="text-[11.5px] font-semibold tabular-nums text-fog">{act.downloads.checking ? "Checking…" : `${Math.round(act.downloads.share * 100)}%`}</span>;
  else if (act.state === "on")
    action = (
      <button type="button" onClick={() => act.turn(false)} className={cn(pill, "bg-chroma/15 text-chroma hover:bg-chroma/25")} title="Switch off">
        <Check size={13} strokeWidth={3} /> On
      </button>
    );
  else if (act.state === "off")
    action = (
      <button type="button" onClick={() => act.turn(true)} className={cn(pill, "bg-paper text-[#16131b] hover:bg-white")} title="You have it: switch it on">
        <Plus size={13} strokeWidth={3} /> Use
      </button>
    );
  else if (act.state === "token")
    action = (
      <button type="button" onClick={onOpen} className={cn(pill, "bg-white/[0.1] text-paper hover:bg-white/[0.16]")} title="Its makers ask for a Hugging Face account: add your token first">
        <KeyRound size={12} /> Token
      </button>
    );
  else if (act.state === "terms")
    action = (
      <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className={cn(pill, "bg-paper text-[#16131b] hover:bg-white")} title="Its makers ask you to accept their terms on Hugging Face first: this opens its page there. Come back and it reads Add.">
        Agree <ArrowUpRight size={12} strokeWidth={2.6} />
      </a>
    );
  else if (act.state === "asking")
    action = (
      <span className={cn(pill, "bg-white/[0.06] text-haze")} title="Asking Hugging Face whether its terms are accepted">
        <LoaderCircle size={13} className="animate-spin" />
      </span>
    );
  else
    action = (
      <button type="button" onClick={() => void act.add()} disabled={act.working || act.state === "no-gpu"} title={act.state === "no-gpu" ? "Connect a GPU first" : act.goesTo ? `It isn't on ${act.goesTo} yet: download it there` : "Download it and switch it on"} className={cn(pill, "lip bg-spike text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-50")}>
        {act.working ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.6} />} Add
      </button>
    );
  return (
    <article className="squircle flex flex-col overflow-hidden rounded-[18px] bg-white/[0.035] transition-colors hover:bg-white/[0.06]" onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)}>
      <button type="button" onClick={peek.waits ? peek.show : onOpen} aria-label={peek.waits ? `${entry.name}: show its maker's example` : `${entry.name}: what it does`} className="relative block aspect-[4/3] w-full overflow-hidden bg-white/[0.03]">
        <Cover entry={entry} play={over} />
        {entry.adult ? (
          <span className="absolute left-2 top-2 rounded-full bg-tally/90 px-2 py-0.5 text-[10.5px] font-bold text-white" title="An adult LoRA: listed because you chose to see them (Settings → Preferences)">
            18+
          </span>
        ) : entry.unchecked ? (
          <span className="absolute left-2 top-2 rounded-full bg-[#0d0c11]/75 px-2 py-0.5 text-[10.5px] font-semibold text-fog">Not checked</span>
        ) : null}
        {entry.clip && !over ? (
          <span className="absolute bottom-2 left-2 grid size-6 place-items-center rounded-full bg-[#0d0c11]/70 text-paper" aria-hidden="true">
            <Play size={10} fill="currentColor" />
          </span>
        ) : null}
        {act.on ? (
          <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-chroma text-[#0c1a12] shadow-[0_2px_8px_rgb(0_0_0/0.4)]" aria-hidden="true">
            <Check size={14} strokeWidth={3} />
          </span>
        ) : null}
        {act.state === "downloading" ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 origin-left bg-spike transition-transform duration-700" style={{ transform: `scaleX(${Math.max(0.03, act.downloads.share)})` }} /> : null}
      </button>
      <div className="flex flex-1 flex-col px-3 pb-3 pt-2.5">
        <button type="button" onClick={onOpen} className="text-left">
          <h4 className="truncate text-[14px] font-semibold text-paper">{entry.name}</h4>
        </button>
        <p className="mt-0.5 line-clamp-2 min-h-[2.6em] text-[12px] leading-[1.3] text-haze">{entry.blurb || `${categoryLabel(entry.category)} · by ${entry.author}`}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-[11.5px] tabular-nums text-haze" title="Downloads in the last month">
            <Download size={11} /> {count(item.downloads)}
          </span>
          {action}
        </div>
        {act.problem ? <Problem text={act.problem} /> : act.full ? <p className="mt-1.5 text-[11.5px] text-tungsten">Up to {MAX_LORAS} at once: switch one off first.</p> : null}
      </div>
    </article>
  );
}

/** A LoRA's own page: its example large, what it does, the words it adds, its one button, and how strong once it's on. */
function LoraPage({ item, crackio, picks, status, model, targets, onBack }: { item: Item; crackio: string; picks: LoraPick[]; status: LocalStatus | null; model: LocalModel; targets: TargetStatus[]; onBack: () => void }) {
  const { entry, view } = item;
  const act = useLoraAction({ item, crackio, picks, status, model, targets });
  const peek = usePeek(entry);
  // A find's repo: what its card says, and the files it holds (the picks bring theirs).
  const [repo, setRepo] = useState<{ of: string; info: RepoInfo } | null>(null);
  useEffect(() => {
    if (!entry.found || entry.uploaded || entry.trained) return;
    let live = true;
    void repoLoraInfo(entry.repo, model).then((info) => live && setRepo({ of: entry.repo, info }));
    return () => {
      live = false;
    };
  }, [entry.found, entry.uploaded, entry.trained, entry.repo, model]);
  const info = repo?.of === entry.repo ? repo.info : null;
  const [choosing, setChoosing] = useState(false);
  const lic = LICENCE[entry.licence.commercial];
  const raw = entry.trigger ?? info?.trigger;
  const trigger = autoTrigger(raw);
  const strength = picks.find((p) => view.files.includes(p.file))?.strength ?? entry.strength;
  const picked = info?.files.filter((f) => info.pick.includes(f.path)) ?? [];
  const size = entry.files.length ? bytesOf(entry) : picked.reduce((n, f) => n + f.bytes, 0) / 1024 ** 3;
  const about = entry.blurb || info?.about || (entry.found && !info ? "" : entry.found ? "Its maker didn't describe it: its example and its page on Hugging Face say more." : "");
  const big = "press inline-flex h-11 items-center gap-2 rounded-full px-5 text-[14px] font-bold";

  let action: ReactNode;
  if (act.state === "downloading")
    action = (
      <div className="max-w-[320px]">
        <Progress share={act.downloads.share} checking={act.downloads.checking} />
      </div>
    );
  else if (act.state === "on")
    action = (
      <button type="button" onClick={() => act.turn(false)} className={cn(big, "bg-chroma/15 text-chroma hover:bg-chroma/25")}>
        <Check size={16} strokeWidth={3} /> On for {model.name} <span className="font-medium text-chroma/70">· switch off</span>
      </button>
    );
  else if (act.state === "off")
    action = (
      <button type="button" onClick={() => act.turn(true)} className={cn(big, "bg-paper text-[#16131b] hover:bg-white")}>
        <Plus size={16} strokeWidth={3} /> Switch on
      </button>
    );
  else if (act.state === "no-gpu") action = <p className="text-[13px] text-tungsten">Connect a GPU in Settings → Machines to add it.</p>;
  else if (act.state === "token")
    action = (
      <Link href="/settings/accounts" className={cn(big, "bg-white/[0.1] text-paper hover:bg-white/[0.16]")}>
        <KeyRound size={15} /> Add your Hugging Face token
      </Link>
    );
  else if (act.state === "terms")
    action = (
      <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className={cn(big, "bg-paper text-[#16131b] hover:bg-white")}>
        Agree to its terms on Hugging Face <ArrowUpRight size={15} strokeWidth={2.6} />
      </a>
    );
  else if (act.state === "asking")
    action = (
      <span className={cn(big, "bg-white/[0.06] text-haze")}>
        <LoaderCircle size={16} className="animate-spin" /> Asking Hugging Face
      </span>
    );
  else
    action = (
      <button type="button" onClick={() => void act.add()} disabled={act.working} className={cn(big, "lip bg-spike text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:opacity-70")}>
        {act.working ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} strokeWidth={2.6} />} Add{size ? ` · ${gb(size)}` : ""}
      </button>
    );

  return (
    <div>
      <button type="button" onClick={onBack} className="press inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.06] pl-2.5 pr-3.5 text-[13px] font-semibold text-fog hover:bg-white/[0.1] hover:text-paper">
        <ArrowLeft size={15} /> All LoRAs
      </button>
      <div className="mt-4 grid gap-5 @min-[700px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @min-[700px]:gap-7">
        <div className="relative aspect-[4/3] overflow-hidden rounded-[20px] bg-black/40">
          <Cover entry={entry} play fit="contain" />
          {/* One nobody checked: its maker's example shows when asked (the whole field is the button). */}
          {peek.waits ? <button type="button" onClick={peek.show} aria-label="Show its maker's example" className="absolute inset-0" /> : null}
        </div>
        <div className="min-w-0">
          <h3 className="font-display text-[26px] uppercase leading-[1.02] text-paper @min-[700px]:text-[30px]">{entry.name}</h3>
          <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-haze">
            <span>
              by{" "}
              <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className="font-semibold text-fog hover:text-paper hover:underline">
                {entry.author}
              </a>
            </span>
            <span className="inline-flex items-center gap-1 tabular-nums" title="Downloads in the last month">
              <Download size={11} /> {count(item.downloads)}
            </span>
            {item.likes ? (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Heart size={11} /> {count(item.likes)}
              </span>
            ) : null}
            <span>{categoryLabel(entry.category)}</span>
          </p>
          {about ? <p className="mt-3.5 text-[14px] leading-relaxed text-fog">{about}</p> : entry.found ? <div className="skeleton mt-3.5 h-12 rounded-[10px]" /> : null}

          {trigger ? (
            <p className="mt-3 text-[13px] leading-relaxed text-haze">
              Crackio adds <span className="font-semibold text-paper">“{trigger.length > 90 ? `${trigger.slice(0, 86)}…` : trigger}”</span> to your prompt for you.
            </p>
          ) : raw ? (
            <p className="mt-3 text-[13px] leading-relaxed text-haze">
              Put <span className="font-semibold text-paper">{raw}</span> in your prompt.
            </p>
          ) : null}
          {entry.note ? <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-haze">{entry.note}</p> : null}

          <div className="mt-5">{action}</div>
          {/* A LoRA whose makers ask for their terms first: where that stands on your Hugging Face account. */}
          {entry.gated && act.state !== "on" && act.state !== "off" && act.state !== "downloading" ? (
            act.state === "token" ? (
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-tungsten">Its makers ask you to accept their terms on Hugging Face. That needs your Hugging Face token here first (Settings → Accounts).</p>
            ) : act.state === "terms" ? (
              <p className="mt-2.5 flex flex-wrap items-center gap-x-2 text-[12.5px] leading-relaxed text-tungsten">
                <TriangleAlert size={13} /> Terms not accepted yet on your Hugging Face account.
                <button type="button" onClick={act.gate.again} className="press font-semibold text-fog underline-offset-2 hover:text-paper hover:underline">
                  Check again
                </button>
              </p>
            ) : act.gate.access === "granted" ? (
              <p className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-chroma">
                <Check size={13} strokeWidth={3} /> Terms accepted on your Hugging Face account.
              </p>
            ) : null
          ) : null}
          {act.problem ? <Problem text={act.problem} /> : act.full ? <p className="mt-2 text-[12.5px] text-tungsten">Up to {MAX_LORAS} at once: switch one off first.</p> : null}
          {act.on ? (
            <div className="mt-4 max-w-[320px]">
              <Slider label="Strength" value={strength} min={entry.range[0]} max={entry.range[1]} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => act.strength(Math.round(v * 100) / 100)} />
            </div>
          ) : null}

          <p className="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-haze">
            <span className={lic.className} title={entry.licence.name}>
              {lic.text}
            </span>
            {entry.tested ? (
              <span className="inline-flex items-center gap-1 text-chroma" title="Crackio ran it on a GPU, with and without it on the same seed: it did what it promises">
                <Check size={11} strokeWidth={3} /> Tested by Crackio
              </span>
            ) : !entry.found ? (
              <span>Checked by Crackio</span>
            ) : (
              <span>Found on Hugging Face: read its page before using it for work</span>
            )}
          </p>

          {info && info.files.length > 1 ? (
            <div className="mt-3 text-[12px] text-haze">
              <button type="button" onClick={() => setChoosing(!choosing)} aria-expanded={choosing} className="press text-left font-semibold leading-snug text-fog hover:text-paper">
                {info.files.length} files in its repo{picked.length ? `: Crackio gets ${picked.map((f) => f.path.split("/").pop()!.replace(/\.safetensors$/i, "")).join(" + ")}` : ""}
              </button>
              {choosing ? (
                <div className="mt-2 rounded-[12px] bg-white/[0.035] p-1.5">
                  {info.files.map((f) => (
                    <button key={f.path} type="button" disabled={act.working} onClick={() => void act.add(f)} title="Get this file instead" className="press flex w-full items-center justify-between gap-3 rounded-[9px] px-2.5 py-1.5 text-left text-[12.5px] text-fog hover:bg-white/[0.06] hover:text-paper">
                      <span className="truncate">
                        {info.pick.includes(f.path) ? <Check size={11} strokeWidth={3} className="mr-1.5 inline -translate-y-px text-chroma" /> : null}
                        {f.path}
                      </span>
                      <span className="shrink-0 tabular-nums text-haze">{gb(f.bytes / 1024 ** 3)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {info?.error ? <Problem text={info.error} /> : null}

          <a href={`https://huggingface.co/${entry.repo}`} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-[12.5px] font-semibold text-haze hover:text-paper">
            Its page on Hugging Face <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
    </div>
  );
}

/** How many LoRAs are switched on for a model (the model library's card shows it). */
export function useLoraCount(crackio: string | null | undefined) {
  return useLorasOn(crackio);
}
