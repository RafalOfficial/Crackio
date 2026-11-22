"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { ArrowRight, Box, Brush, Check, CircleAlert, Clock, Cpu, Download, FolderOpen, ImagePlus, LoaderCircle, PawPrint, RotateCcw, Sparkles, Trash2, User, Wand2, X } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Segmented, Switch } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";
import { formatDuration, RANKS, RESOLUTIONS, SETTING_HELP, captionFor, setFacts, setVerdict, suggestTrigger, testPrompts, TEST_PROMPTS, trainable } from "@/lib/train/plan";
import { GOAL_IMAGES } from "@/lib/train/profiles";
import type { TrainOptions } from "@/lib/server/train/options";
import type { SettingKey, TrainGoal, TrainImage, TrainJob, TrainSettings } from "@/lib/train/types";
import type { TrainPatch, Upload } from "@/lib/hooks/use-train";
import { Choice, Field, GB, More, Step, Tag, money } from "./parts";

/**
 * The workbench of a LoRA that hasn't started: what it teaches, its pictures, the model, the machine and the settings,
 * top to bottom in the order they depend on each other. Every setting says what it does and why Crackio picked its value.
 */

const GOALS: { id: TrainGoal; label: string; line: string; icon: typeof User }[] = [
  { id: "person", label: "A person", line: "One real person's face and look", icon: User },
  { id: "character", label: "A character", line: "A mascot, a pet, a drawn or 3D figure", icon: PawPrint },
  { id: "object", label: "A thing", line: "A product, a car, a piece of clothing", icon: Box },
  { id: "style", label: "A look", line: "An art style, a photo look, a brand's visuals", icon: Brush },
  { id: "edit", label: "A change", line: "Before and after pairs: an edit it then makes to any picture", icon: Wand2 },
];

const NOUN_HINT: Record<TrainGoal, string> = { person: "woman, man, boy…", character: "corgi, robot, cartoon fox…", object: "sneaker, perfume bottle…", style: "", edit: "" };

type Props = {
  job: TrainJob;
  options: TrainOptions | null;
  upload: Upload;
  patch: (p: TrainPatch) => void;
  addImages: (files: File[], as?: "before") => void;
  removeImages: (ids: string[]) => void;
  removeBefore: (ids: string[]) => void;
  clearUpload: () => void;
};

/**
 * The settings as the page shows them: Crackio's picks for the ones left to it, your own for the rest. Yours come from
 * the job, which changes the moment you change it; the picks come with the options, asked again after each change (a
 * slider read from those alone snapped back under the pointer until they arrived).
 */
function shownSettings(job: TrainJob, options: TrainOptions | null): TrainSettings {
  const picks = options?.settings ?? job.settings;
  const mine = Object.fromEntries(Object.entries(job.settings).filter(([k]) => !job.auto.includes(k as SettingKey)));
  return { ...picks, ...mine } as TrainSettings;
}

export function Draft({ job, options, upload, patch, addImages, removeImages, removeBefore, clearUpload }: Props) {
  const settings = shownSettings(job, options);
  // An edit LoRA learns from pairs (before and after), and is called by its instruction, not a trigger word.
  const edit = job.goal === "edit";
  const used = trainable(job.images, job.goal);
  const verdict = setVerdict(job.goal, used.length);
  const named = job.name.trim() && job.name !== "New LoRA" && (edit ? (job.instruction ?? "").trim() : job.trigger.trim());
  // A new LoRA starts on Crackio's picks: its main model, and the machine that would finish first. Both can be changed.
  const firstBase = options?.bases[0]?.id;
  const pickedMachine = options?.machines.find((m) => m.recommended)?.id;
  useEffect(() => {
    if (!job.base && firstBase) patch({ base: { kind: "catalog", family: firstBase } });
    else if (!job.machine && pickedMachine) patch({ machine: pickedMachine });
  }, [job.base, job.machine, firstBase, pickedMachine, patch]);
  return (
    <div>
      <Step n={1} title="What should it learn?" done={Boolean(named)}>
        <div role="radiogroup" aria-label="What the pictures teach" className="grid grid-cols-2 gap-2.5 @min-[560px]:grid-cols-3 @min-[880px]:grid-cols-5">
          {GOALS.map((g) => (
            <Choice key={g.id} on={job.goal === g.id} onClick={() => patch({ goal: g.id })}>
              <g.icon size={18} className={job.goal === g.id ? "text-daylight" : "text-haze"} />
              <span className="mt-2.5 block text-[14px] font-semibold text-paper">{g.label}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-haze">{g.line}</span>
            </Choice>
          ))}
        </div>
        {edit ? (
          <>
            <div className="mt-4 grid gap-3 @min-[600px]:grid-cols-[1fr_1.7fr]">
              <Field label="Its name" value={job.name === "New LoRA" ? "" : job.name} placeholder="Clay figure" maxLength={60} onCommit={(name) => patch({ name: name || "New LoRA" })} />
              <Field label="The change, as you&rsquo;d ask for it" value={job.instruction ?? ""} placeholder="Turn the photo into a clay figure" maxLength={400} onCommit={(instruction) => patch({ instruction })} />
            </div>
            <p className="mt-2.5 max-w-[72ch] text-[12.5px] leading-relaxed text-haze">
              Every pair trains with this instruction, and it&rsquo;s what you type afterwards, with the picture to change, to get the edit. Say it plainly. A pair that needs other words can have its own.
            </p>
          </>
        ) : (
          <>
        <div className="mt-4 grid gap-3 @min-[600px]:grid-cols-[1.3fr_1fr_1fr]">
          <Field
            label="Its name"
            value={job.name === "New LoRA" ? "" : job.name}
            placeholder={job.goal === "style" ? "Clay look" : job.goal === "object" ? "Red sneaker" : "Lena"}
            maxLength={60}
            onCommit={(name) => patch({ name: name || "New LoRA", ...(name && !job.trigger ? { trigger: suggestTrigger(name) } : {}) })}
          />
          <div>
            <Field label="Trigger word" value={job.trigger} placeholder="lenavq" maxLength={40} mono onCommit={(trigger) => patch({ trigger })} />
          </div>
          {job.goal !== "style" ? <Field label="What it is, in a word or two" value={job.noun} placeholder={NOUN_HINT[job.goal]} maxLength={40} onCommit={(noun) => patch({ noun })} /> : null}
        </div>
        <p className="mt-2.5 max-w-[72ch] text-[12.5px] leading-relaxed text-haze">
          The trigger word calls your LoRA in a prompt. A made-up word works best: a real one already means something to the model. Crackio adds it for you whenever the LoRA is switched on.
        </p>
          </>
        )}
      </Step>

      <Step
        n={2}
        title={edit ? "Before and after" : "Pictures"}
        done={verdict.ok}
        hint={edit ? "Each pair is one picture before the change and after it. What differs inside a pair is what the LoRA learns. What all your pairs share beyond that (one person, one room) it may learn too, so vary what they show." : job.goal === "style" ? "Pictures in the look you want, of different things. The more the subjects vary, the more clearly the look is what they share." : "Pictures of it alone: different angles, places, light and clothes. What changes between pictures is what the LoRA leaves free; what stays the same is what it learns."}
        aside={used.length ? <Tag tone={verdict.tone === "great" ? "good" : verdict.tone === "bad" ? "bad" : verdict.tone === "thin" ? "warn" : "info"}>{used.length} {edit ? (used.length === 1 ? "pair" : "pairs") : used.length === 1 ? "picture" : "pictures"}</Tag> : null}
      >
        {edit ? (
          <Pairs job={job} upload={upload} addImages={addImages} removeImages={removeImages} removeBefore={removeBefore} patch={patch} clearUpload={clearUpload} />
        ) : (
          <Pictures job={job} upload={upload} resolution={settings.resolution} addImages={addImages} removeImages={removeImages} patch={patch} clearUpload={clearUpload} />
        )}
        {used.length ? <p className={cn("mt-3 text-[13px]", verdict.tone === "bad" ? "text-tally" : verdict.tone === "thin" ? "text-tungsten" : "text-fog")}>{verdict.text}</p> : null}
      </Step>

      <Step n={3} title="Model" done={Boolean(job.base)} hint={edit ? "The model that learns the change: one that takes a picture to change beside the prompt. The LoRA only works with that model (and close relatives of it)." : "The model your LoRA is made for. It only works with that model (and close relatives of it), so pick the one you make pictures with."}>
        <Models job={job} options={options} patch={patch} />
      </Step>

      <Step n={4} title="Where it trains" done={Boolean(job.machine)} hint="Training keeps a GPU busy for the whole run. Your own machines are free; rented ones cost what their cloud charges by the hour.">
        <Machines job={job} options={options} patch={patch} />
      </Step>

      <Step n={5} title="Settings" done hint="Crackio set every one of these from your pictures, the model and the machine. Change one and it stays yours; the rest keep following the set.">
        <SettingsList job={job} options={options} settings={settings} patch={patch} />
      </Step>
    </div>
  );
}

/* ------------------------------------------------------------------ pictures */

function Pictures({ job, upload, resolution, addImages, removeImages, patch, clearUpload }: { job: TrainJob; upload: Upload; resolution: number; addImages: (f: File[]) => void; removeImages: (ids: string[]) => void; patch: (p: TrainPatch) => void; clearUpload: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addImages([...e.dataTransfer.files]);
  };
  const facts = setFacts(job.images, resolution, job.goal);
  const ideal = GOAL_IMAGES[job.goal].ideal;
  const picked = job.images.find((i) => i.id === open) ?? null;
  const busy = upload && upload.done < upload.total;
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn("squircle rounded-[18px] p-3 transition-[box-shadow,background-color] duration-150", over ? "bg-daylight/[0.07] shadow-[inset_0_0_0_1.5px_rgb(142_197_255/0.6)]" : "bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]")}
    >
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => (addImages([...(e.target.files ?? [])]), (e.target.value = ""))} />
      {job.images.length ? (
        <>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5">
            {job.images.map((image, n) => (
              <li key={image.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === image.id ? null : image.id)}
                  aria-pressed={open === image.id}
                  title={leftOut(image) ?? image.name}
                  className={cn("press group relative block aspect-square w-full overflow-hidden rounded-[10px] bg-apple", open === image.id && "shadow-[0_0_0_2px_var(--color-daylight)]")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/train/${job.id}/file/images/${image.id}?w=200`} alt="" loading="lazy" decoding="async" className={cn("size-full object-cover", leftOut(image) && "opacity-30 grayscale")} />
                  <span className="tabular absolute bottom-1 left-1 rounded-[5px] bg-black/55 px-1 text-[10px] font-semibold text-paper/85">{n + 1}</span>
                  {leftOut(image) ? <CircleAlert size={14} className="absolute right-1 top-1 text-tungsten" /> : image.captionBy === "you" ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-daylight" /> : null}
                </button>
              </li>
            ))}
            <li>
              <button type="button" onClick={() => input.current?.click()} className="press grid aspect-square w-full place-items-center rounded-[10px] text-haze shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.05] hover:text-paper" aria-label="Add pictures">
                {busy ? <LoaderCircle size={18} className="animate-spin" /> : <ImagePlus size={18} />}
              </button>
            </li>
          </ul>
          {picked ? <PictureDetail job={job} image={picked} n={job.images.indexOf(picked) + 1} onClose={() => setOpen(null)} onRemove={() => (removeImages([picked.id]), setOpen(null))} patch={patch} /> : null}
          <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[12px] text-haze">
            <span>Drop more anywhere here. Click a picture to see or write its caption.</span>
            {facts.skipped ? <span className="text-tungsten">{facts.skipped} left out (doubles or too small)</span> : null}
            {facts.small ? <span>{facts.small} under 700 px train at their own size</span> : null}
          </p>
        </>
      ) : (
        <button type="button" onClick={() => input.current?.click()} className="press grid w-full place-items-center gap-2 rounded-[14px] px-6 py-12 text-center hover:bg-white/[0.03]">
          <ImagePlus size={26} className="text-haze" />
          <span className="text-[15px] font-semibold text-paper">Drop your pictures here</span>
          <span className="max-w-[46ch] text-[13px] leading-relaxed text-haze">
            Or click to choose them. {ideal[0]}–{ideal[1]} is ideal, {GOAL_IMAGES[job.goal].least} is the least, up to 300. Any shape and size: nothing is cropped.
          </span>
        </button>
      )}
      <UploadNote upload={upload} clearUpload={clearUpload} />
    </div>
  );
}

/** What an upload is doing, and what it refused. */
function UploadNote({ upload, clearUpload }: { upload: Upload; clearUpload: () => void }) {
  const busy = upload && upload.done < upload.total;
  return (
    <>
      {upload ? (
        <div className="mt-2.5 rounded-[12px] bg-white/[0.04] px-3 py-2.5 text-[12.5px]">
          {busy ? (
            <p className="flex items-center gap-2 text-fog">
              <LoaderCircle size={13} className="animate-spin" /> Adding pictures · {upload.done} of {upload.total}
            </p>
          ) : null}
          {upload.refused.length ? (
            <div className="flex items-start gap-2 text-tungsten">
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                {upload.refused.slice(0, 4).map((r, i) => (
                  <p key={i} className="truncate">
                    {r.name}: {r.why}
                  </p>
                ))}
                {upload.refused.length > 4 ? <p>and {upload.refused.length - 4} more</p> : null}
              </div>
              {!busy ? (
                <button type="button" onClick={clearUpload} aria-label="Dismiss" className="press grid size-6 place-items-center rounded-full hover:bg-white/[0.08]">
                  <X size={13} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ pairs (an edit LoRA's set) */

const pairSrc = (job: TrainJob, image: TrainImage, side: "before" | "after", w: number) =>
  side === "after" || image.waiting ? `/api/train/${job.id}/file/images/${image.id}?w=${w}` : `/api/train/${job.id}/file/before/${image.id}?w=${w}&v=${image.source?.file ?? ""}`;

/**
 * Why a picture isn't trained on, when it isn't (outside an edit): left out, or a before picture added for "A change"
 * that never got its after picture (it would teach a look what it was meant to change).
 */
const leftOut = (image: TrainImage) => image.skip ?? (image.waiting ? "A before picture of a change, with no after picture" : undefined);

/** Which of a pair's two pictures there is: a before picture still waiting has no after one, and the other way round. */
const pairHas = (image: TrainImage) => ({ before: Boolean(image.waiting || image.source), after: !image.waiting });

function Pairs({
  job,
  upload,
  addImages,
  removeImages,
  removeBefore,
  patch,
  clearUpload,
}: {
  job: TrainJob;
  upload: Upload;
  addImages: (f: File[], as?: "before") => void;
  removeImages: (ids: string[]) => void;
  removeBefore: (ids: string[]) => void;
  patch: (p: TrainPatch) => void;
  clearUpload: () => void;
}) {
  const before = useRef<HTMLInputElement>(null);
  const after = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const facts = setFacts(job.images, 1024, "edit");
  const picked = job.images.find((i) => i.id === open) ?? null;
  const busy = upload && upload.done < upload.total;
  const empty = !job.images.length;
  const zone = (side: "before" | "after", title: string, line: string) => (
    <button
      type="button"
      onClick={() => (side === "before" ? before : after).current?.click()}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(side);
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(null);
        addImages([...e.dataTransfer.files], side === "before" ? "before" : undefined);
      }}
      className={cn(
        "press squircle grid w-full place-items-center rounded-[14px] px-4 text-center transition-[box-shadow,background-color] duration-150",
        empty ? "gap-1.5 py-9" : "gap-0.5 py-3",
        over === side ? "bg-daylight/[0.07] shadow-[inset_0_0_0_1.5px_rgb(142_197_255/0.6)]" : "bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-white/[0.045]",
      )}
    >
      {empty ? <ImagePlus size={22} className="text-haze" /> : null}
      <span className={cn("font-semibold text-paper", empty ? "text-[15px]" : "text-[13px]")}>{title}</span>
      <span className="max-w-[34ch] text-[12.5px] leading-snug text-haze">{line}</span>
    </button>
  );
  return (
    <div>
      <input ref={before} type="file" accept="image/*" multiple hidden onChange={(e) => (addImages([...(e.target.files ?? [])], "before"), (e.target.value = ""))} />
      <input ref={after} type="file" accept="image/*" multiple hidden onChange={(e) => (addImages([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        {zone("before", empty ? "Before" : "Add before pictures", empty ? "The pictures as they are. Drop them here, or click to choose." : "as they are")}
        {busy ? <LoaderCircle size={16} className="animate-spin text-haze" /> : <ArrowRight size={16} className="text-haze" aria-hidden="true" />}
        {zone("after", empty ? "After" : "Add after pictures", empty ? "The same pictures with the change made. Drop them here, or click to choose." : "with the change made")}
      </div>
      <p className="mt-2.5 px-0.5 text-[12px] leading-relaxed text-haze">
        Pictures with the same file name pair up (cat.jpg with cat.jpg, or cat_before.jpg with cat_after.jpg, dropped on either side). The rest pair in the order you add them.
      </p>
      {job.images.length ? (
        <>
          <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2">
            {job.images.map((image, n) => {
              const has = pairHas(image);
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === image.id ? null : image.id)}
                    aria-pressed={open === image.id}
                    title={image.skip ?? (has.before && has.after ? image.name : has.after ? "No before picture yet" : "No after picture: redone as a test picture")}
                    className={cn("press relative grid w-full grid-cols-2 gap-px overflow-hidden rounded-[10px] bg-apple", open === image.id && "shadow-[0_0_0_2px_var(--color-daylight)]")}
                  >
                    {(["before", "after"] as const).map((side) =>
                      has[side] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={side} src={pairSrc(job, image, side, 200)} alt="" loading="lazy" decoding="async" className={cn("aspect-square w-full object-cover", image.skip && "opacity-30 grayscale")} />
                      ) : (
                        <span key={side} className="grid aspect-square w-full place-items-center bg-white/[0.03] text-[11px] font-semibold text-tungsten">
                          {side === "before" ? "Before?" : "Test"}
                        </span>
                      ),
                    )}
                    <span className="tabular absolute bottom-1 left-1 rounded-[5px] bg-black/55 px-1 text-[10px] font-semibold text-paper/85">{n + 1}</span>
                    {image.skip ? <CircleAlert size={14} className="absolute right-1 top-1 text-tungsten" /> : image.captionBy === "you" ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-daylight" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {picked ? (
            <PairDetail
              job={job}
              image={picked}
              n={job.images.indexOf(picked) + 1}
              onClose={() => setOpen(null)}
              onRemove={() => (removeImages([picked.id]), setOpen(null))}
              onRemoveBefore={() => removeBefore([picked.id])}
              patch={patch}
            />
          ) : null}
          <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[12px] text-haze">
            <span>Click a pair to see it, or to give it words of its own.</span>
            {facts.unpaired ? (
              <span className="text-tungsten">
                {facts.unpaired} {facts.unpaired === 1 ? "has" : "have"} no before picture yet: left out until {facts.unpaired === 1 ? "it has" : "they have"} one
              </span>
            ) : null}
            {facts.waiting ? (
              <span>
                {facts.waiting} before {facts.waiting === 1 ? "picture has" : "pictures have"} no after picture: redone as test pictures
              </span>
            ) : null}
            {facts.skipped ? <span className="text-tungsten">{facts.skipped} left out</span> : null}
          </p>
        </>
      ) : null}
      <UploadNote upload={upload} clearUpload={clearUpload} />
    </div>
  );
}

function PairDetail({ job, image, n, onClose, onRemove, onRemoveBefore, patch }: { job: TrainJob; image: TrainImage; n: number; onClose: () => void; onRemove: () => void; onRemoveBefore: () => void; patch: (p: TrainPatch) => void }) {
  const [text, setText] = useState(image.caption ?? "");
  const [at, setAt] = useState(image.id);
  if (at !== image.id) {
    setAt(image.id);
    setText(image.caption ?? "");
  }
  const has = pairHas(image);
  const goes = captionFor(job, { caption: text });
  return (
    <div className="mt-2.5 flex flex-wrap gap-3.5 rounded-[14px] bg-white/[0.04] p-3">
      <div className="flex min-w-0 max-w-full items-center gap-2 @min-[640px]:max-w-[56%]">
        {(["before", "after"] as const).map((side) => (
          <div key={side} className="min-w-0 flex-1">
            {has[side] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pairSrc(job, image, side, 480)} alt={side === "before" ? "Before" : "After"} className="max-h-[220px] w-full rounded-[10px] object-contain" />
            ) : (
              <div className="grid aspect-square max-h-[220px] w-full place-items-center rounded-[10px] bg-white/[0.03] px-3 text-center text-[12px] leading-snug text-haze shadow-[inset_0_0_0_1px_var(--color-line)]">
                {side === "before" ? "No before picture yet" : "No after picture"}
              </div>
            )}
            <p className="mt-1 text-center text-[11.5px] font-semibold text-haze">{side === "before" ? "Before" : "After"}</p>
          </div>
        ))}
      </div>
      <div className="min-w-[220px] flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[13px] font-semibold text-paper">
            {n}. {image.name}
          </p>
          <button type="button" onClick={onClose} aria-label="Close" className="press grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
            <X size={14} />
          </button>
        </div>
        {image.skip ? <p className="mt-1 text-[12.5px] text-tungsten">Left out: {image.skip}.</p> : null}
        {image.waiting ? (
          <p className="mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-fog">
            A before picture with no after picture trains nothing. Crackio redoes it with every saved version instead, so you see the change on a picture the LoRA never learned from. Drop its after picture on After (same file name) to make it a pair.
          </p>
        ) : !image.source ? (
          <p className="mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-tungsten">No before picture yet, so it&rsquo;s left out. Drop one on Before with the same file name, or the next one you add there goes to the first pair without one.</p>
        ) : (
          <>
            <label className="mt-2.5 block">
              <span className="text-[12px] font-medium text-haze">This pair&rsquo;s own instruction {image.captionBy === "you" ? "(yours)" : ""}</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => text.trim() !== (image.caption ?? "") && patch({ captions: [{ id: image.id, caption: text }] })}
                rows={2}
                maxLength={1000}
                placeholder="Empty: the instruction above. Write one here when this pair needs other words."
                className="field-focus squircle mt-1.5 w-full resize-y rounded-[12px] bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-paper outline-none placeholder:text-haze/70"
              />
            </label>
            {goes ? (
              <p className="mt-1.5 text-[12px] leading-relaxed text-haze">
                Trains as: <span className="text-fog">{goes}</span>
              </p>
            ) : (
              <p className="mt-1.5 text-[12px] leading-relaxed text-tungsten">Say what the change is (step 1), or write it here for this pair.</p>
            )}
          </>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {!image.waiting ? (
            <button type="button" onClick={() => patch({ skip: [{ id: image.id, skip: !image.skip }] })} className="press h-8 rounded-full bg-white/[0.06] px-3 text-[12px] font-semibold text-fog hover:text-paper">
              {image.skip ? "Use it after all" : "Leave it out"}
            </button>
          ) : null}
          {image.source ? (
            <button type="button" onClick={onRemoveBefore} className="press h-8 rounded-full bg-white/[0.06] px-3 text-[12px] font-semibold text-fog hover:text-paper">
              Take the before picture off
            </button>
          ) : null}
          <button type="button" onClick={onRemove} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold text-haze hover:bg-tally/12 hover:text-tally">
            <Trash2 size={12} /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}

function PictureDetail({ job, image, n, onClose, onRemove, patch }: { job: TrainJob; image: TrainImage; n: number; onClose: () => void; onRemove: () => void; patch: (p: TrainPatch) => void }) {
  const [text, setText] = useState(image.caption ?? "");
  const [at, setAt] = useState(image.id);
  if (at !== image.id) {
    setAt(image.id);
    setText(image.caption ?? "");
  }
  const goes = captionFor(job, { caption: text });
  return (
    <div className="mt-2.5 flex flex-wrap gap-3.5 rounded-[14px] bg-white/[0.04] p-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/train/${job.id}/file/images/${image.id}?w=480`} alt="" className="max-h-[220px] w-auto max-w-[45%] rounded-[10px] object-contain" />
      <div className="min-w-[220px] flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[13px] font-semibold text-paper">
            {n}. {image.name}
            <span className="ml-2 font-normal text-haze">
              {image.width}×{image.height}
            </span>
          </p>
          <button type="button" onClick={onClose} aria-label="Close" className="press grid size-7 shrink-0 place-items-center rounded-full text-haze hover:bg-white/[0.08] hover:text-paper">
            <X size={14} />
          </button>
        </div>
        {leftOut(image) ? <p className="mt-1 text-[12.5px] text-tungsten">Left out: {leftOut(image)}.</p> : null}
        <label className="mt-2.5 block">
          <span className="text-[12px] font-medium text-haze">Caption {image.captionBy === "crackio" ? "(written by Crackio)" : image.captionBy === "you" ? "(yours)" : ""}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text.trim() !== (image.caption ?? "") && patch({ captions: [{ id: image.id, caption: text }] })}
            rows={3}
            maxLength={1000}
            placeholder={job.settings.captions === "auto" && job.auto.includes("captions") ? "Empty: Crackio writes one when training starts (and stops to ask if it can't). Or write your own." : "Empty: the trigger word alone. Or describe what's around the subject."}
            className="field-focus squircle mt-1.5 w-full resize-y rounded-[12px] bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-paper outline-none placeholder:text-haze/70"
          />
        </label>
        {goes ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-haze">
            Trains as: <span className="text-fog">{goes}</span>
          </p>
        ) : null}
        <div className="mt-2.5 flex gap-2">
          <button type="button" onClick={() => patch({ skip: [{ id: image.id, skip: !leftOut(image) }] })} className="press h-8 rounded-full bg-white/[0.06] px-3 text-[12px] font-semibold text-fog hover:text-paper">
            {leftOut(image) ? "Use it after all" : "Leave it out"}
          </button>
          <button type="button" onClick={onRemove} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold text-haze hover:bg-tally/12 hover:text-tally">
            <Trash2 size={12} /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ models */

const LICENCE = { yes: "Commercial use OK", limited: "Commercial, with limits", no: "Non-commercial" } as const;

function Models({ job, options, patch }: { job: TrainJob; options: TrainOptions | null; patch: (p: TrainPatch) => void }) {
  const bases = options?.bases ?? [];
  const custom = options?.custom;
  const machine = options?.machines.find((m) => m.id === job.machine);
  if (!options) return <div className="skeleton h-[150px] rounded-[16px]" />;
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Model to train" className="grid gap-2.5 @min-[560px]:grid-cols-2 @min-[1000px]:grid-cols-3">
        {bases.map((b) => {
          const on = job.base?.kind === "catalog" && job.base.family === b.id;
          return (
            <Choice key={b.id} on={on} onClick={() => patch({ base: { kind: "catalog", family: b.id } })} className="flex flex-col">
              <span className="flex items-center justify-between gap-2">
                <span className="text-[14.5px] font-semibold text-paper">{b.name}</span>
                {on ? <Check size={15} className="shrink-0 text-daylight" strokeWidth={3} /> : null}
              </span>
              <span className="mt-0.5 text-[12px] text-haze">{b.maker}</span>
              <span className="mt-2 flex-1 text-[12.5px] leading-relaxed text-fog">{b.blurb}</span>
              <span className="mt-3 flex flex-wrap gap-1.5">
                {b.tested ? <Tag tone="good" title="Crackio trained a LoRA on it end to end and checked the result">Tested</Tag> : <Tag title="Set up from its makers' and the community's recipes; Crackio hasn't run it end to end yet">Not tested yet</Tag>}
                <Tag tone={b.licence.commercial === "no" ? "warn" : "plain"} title={b.licence.note ?? b.licence.name}>
                  {LICENCE[b.licence.commercial]}
                </Tag>
                {b.download ? (
                  <Tag title={`Its training weights download to ${machine?.label ?? "the machine"} first`}>
                    <Download size={11} /> {GB(b.download)}
                  </Tag>
                ) : b.download === 0 ? (
                  <Tag tone="info">On {machine?.label ?? "the machine"}</Tag>
                ) : null}
              </span>
              {b.note ? <span className="mt-2 text-[11.5px] leading-snug text-haze">{b.note}</span> : null}
            </Choice>
          );
        })}
      </div>

      <div className="rounded-[16px] bg-white/[0.025] p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-paper">
          <FolderOpen size={15} className="text-haze" /> A model file of your own
        </p>
        <p className="mt-1 max-w-[76ch] text-[12.5px] leading-relaxed text-haze">
          A fine-tune or merge you downloaded. Put its .safetensors file in the machine&rsquo;s ComfyUI folder{" "}
          <code className="rounded-[5px] bg-white/[0.07] px-1 py-px font-mono text-[11.5px] text-fog">{custom?.folder ?? "models/diffusion_models"}</code> (all-in-one checkpoints: <code className="rounded-[5px] bg-white/[0.07] px-1 py-px font-mono text-[11.5px] text-fog">models/checkpoints</code>) and it shows up here. Crackio reads what it is and whether this machine can train it.
        </p>
        {!job.machine ? (
          <p className="mt-2.5 text-[12.5px] text-fog">Pick a machine below to see the model files on it.</p>
        ) : custom && custom.models.length ? (
          <div role="radiogroup" aria-label="Your model files" className="mt-3 grid gap-2 @min-[560px]:grid-cols-2">
            {custom.models.map((m) => {
              const on = job.base?.kind === "custom" && job.base.file === m.file && job.base.folder === m.folder;
              return (
                <Choice key={`${m.folder}/${m.file}`} on={on} disabled={!m.family} onClick={() => m.family && patch({ base: { kind: "custom", family: m.family, folder: m.folder, file: m.file } })}>
                  <span className="block truncate text-[13.5px] font-semibold text-paper" title={m.file}>
                    {m.file}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-haze">
                    {GB(m.bytes)}
                    {m.facts ? ` · ${m.facts}` : ""}
                  </span>
                  <span className={cn("mt-1.5 block text-[12px] leading-snug", m.problem ? "text-tungsten" : "text-fog")}>{m.problem ?? `Trains as ${m.familyName}, with its text encoder and VAE.`}</span>
                </Choice>
              );
            })}
          </div>
        ) : (
          <p className="mt-2.5 text-[12.5px] text-fog">{machine?.online ? `No model files of your own on ${machine.label} yet.` : `${machine?.label ?? "That machine"} isn't answering, so its files can't be read right now.`}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ machines */

const FIT_TONE = { great: "good", ok: "info", slow: "warn", no: "bad" } as const;
const FIT_WORD = { great: "Runs well", ok: "Fits", slow: "Slow", no: "Can't train this" } as const;

function Machines({ job, options, patch }: { job: TrainJob; options: TrainOptions | null; patch: (p: TrainPatch) => void }) {
  if (!options) return <div className="skeleton h-[120px] rounded-[16px]" />;
  if (!options.machines.length) {
    return (
      <p className="rounded-[14px] bg-white/[0.03] px-4 py-3.5 text-[13px] leading-relaxed text-fog">
        No machine with a GPU is connected yet. Set up ComfyUI on this computer or connect a rented GPU under{" "}
        <a href="/settings/machines" className="font-semibold text-paper underline decoration-white/30 underline-offset-2">
          Settings → Machines
        </a>
        .
      </p>
    );
  }
  return (
    <div role="radiogroup" aria-label="Machine to train on" className="space-y-2">
      {options.machines.map((m) => {
        const on = job.machine === m.id;
        const est = m.estimate;
        return (
          <Choice key={m.id} on={on} disabled={!m.usable} onClick={() => patch({ machine: m.id })} className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 py-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/[0.06] text-fog">
              <Cpu size={18} />
            </span>
            <span className="min-w-[170px] flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-semibold text-paper">{m.label}</span>
                {m.recommended ? <Tag tone="info">Crackio&rsquo;s pick</Tag> : null}
                {!m.online ? <Tag tone="warn">Off</Tag> : null}
              </span>
              <span className="mt-0.5 block text-[12px] text-haze">
                {m.where.replace(/\s*·.*$/, "")}
                {m.gpu?.memoryGb ? ` · ${Math.round(m.gpu.memoryGb)} GB` : ""}
                {m.pricePerHour ? ` · ${money(m.pricePerHour)} an hour` : m.kind === "this-computer" || m.kind === "lan" ? " · free" : ""}
              </span>
              {m.notice ? <span className="mt-1 block text-[12px] text-tungsten">{m.notice}</span> : null}
            </span>
            {m.fit ? (
              <span className="min-w-[150px]">
                <Tag tone={FIT_TONE[m.fit.state]}>{FIT_WORD[m.fit.state]}</Tag>
                <span className="mt-1 block text-[12px] leading-snug text-haze">{m.fit.why}</span>
              </span>
            ) : (
              <span className="min-w-[150px] text-[12px] text-haze">{!job.base ? "Pick a model to see how it runs here" : m.online ? "Crackio can't see its GPU" : "Its GPU isn't known while it's off"}</span>
            )}
            <span className="min-w-[120px] text-right">
              {est ? (
                <>
                  <span className="tabular block text-[15px] font-semibold text-paper">{formatDuration(est.seconds)}</span>
                  <span className="block text-[11.5px] text-haze">
                    {est.cost ? `about ${money(est.cost)}` : est.basis === "measured" ? "measured on this card" : "estimated"}
                    {m.download ? ` · +${GB(m.download)} first` : ""}
                  </span>
                </>
              ) : null}
            </span>
          </Choice>
        );
      })}
      {options.machines.every((m) => !m.usable) ? (
        <p className="rounded-[14px] bg-white/[0.03] px-4 py-3 text-[12.5px] leading-relaxed text-fog">
          None of your machines can train this model right now. A rented GPU with 16 GB or more does it for well under a dollar a run: rent one at RunPod or vast.ai and it connects by itself (
          <a href="/settings/machines" className="font-semibold text-paper underline decoration-white/30 underline-offset-2">
            Settings → Machines
          </a>
          ).
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsList({ job, options, settings, patch }: { job: TrainJob; options: TrainOptions | null; settings: TrainSettings; patch: (p: TrainPatch) => void }) {
  const [more, setMore] = useState(false);
  const why = options?.plan.why;
  const set = <K extends SettingKey>(key: K, value: TrainSettings[K]) => patch({ settings: { [key]: value } as Partial<TrainSettings> });
  const row = (key: SettingKey, control: React.ReactNode, value?: string) => {
    const help = SETTING_HELP[key];
    const mine = !job.auto.includes(key);
    return (
      <div key={key} className="grid gap-x-6 gap-y-2 px-4 py-3.5 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(200px,280px)] @min-[640px]:items-start">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold text-paper">
            {help.label}
            {value ? <span className="tabular font-medium text-fog">{value}</span> : null}
            {mine ? (
              <button type="button" onClick={() => patch({ auto: [key] })} className="press inline-flex h-[22px] items-center gap-1 rounded-full bg-white/[0.07] px-2 text-[11.5px] font-semibold text-fog hover:text-paper" title="Hand it back to Crackio">
                <RotateCcw size={10} /> Yours · reset
              </button>
            ) : (
              <span className="inline-flex h-[22px] items-center gap-1 rounded-full bg-daylight/10 px-2 text-[11.5px] font-semibold text-daylight">
                <Sparkles size={10} /> Crackio&rsquo;s pick
              </span>
            )}
          </p>
          <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-haze">
            {help.what}
            <More>{help.more}</More>
          </p>
          {!mine && why ? <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-fog">{why[key]}</p> : null}
        </div>
        <div className="min-w-0 @min-[640px]:pt-0.5">{control}</div>
      </div>
    );
  };
  const steps = settings.steps;
  return (
    <div className="squircle divide-y divide-line rounded-[18px] bg-white/[0.025] shadow-[inset_0_0_0_1px_var(--color-line)]">
      {row("steps", <Slider label="" value={steps} min={300} max={8000} step={100} format={() => null} onChange={(v) => set("steps", v)} hint={["Lighter touch", "Stronger, riskier"]} />, steps.toLocaleString("en-US"))}
      {row(
        "resolution",
        <Segmented size="md" label="Picture size" value={String(settings.resolution)} options={RESOLUTIONS.filter((r) => r >= 512 && r <= 1536 && r !== 640 && r !== 896).map((r) => ({ id: String(r), label: String(r) }))} onChange={(v) => set("resolution", Number(v))} />,
        `${settings.resolution} px`,
      )}
      {row("rank", <Segmented size="md" label="LoRA size" value={String(settings.rank)} options={RANKS.filter((r) => r >= 8 && r <= 64).map((r) => ({ id: String(r), label: String(r) }))} onChange={(v) => set("rank", Number(v))} />, String(settings.rank))}
      {row("checkpoints", <Slider label="" value={settings.checkpoints} min={1} max={12} step={1} format={() => null} onChange={(v) => set("checkpoints", v)} />, `${settings.checkpoints}, one every ${Math.max(1, Math.round(steps / settings.checkpoints / 50) * 50).toLocaleString("en-US")} steps`)}
      {row("previews", <Switch checked={settings.previews} onChange={(v) => set("previews", v)} label={settings.previews ? "On" : "Off"} />)}
      {settings.previews && job.goal === "edit" ? (
        <div className="px-4 py-3.5">
          <p className="text-[13px] font-semibold text-paper">What the test pictures show</p>
          <p className="mt-1.5 max-w-[80ch] text-[12.5px] leading-relaxed text-haze">
            {job.images.some((i) => i.waiting) ? "Your before pictures that have no after picture, redone with the instruction." : "The first two pairs' before pictures, redone with the instruction."} To test on a picture the LoRA never learned from, add a before picture and
            leave its after picture out.
          </p>
        </div>
      ) : settings.previews ? (
        <TestPrompts job={job} patch={patch} />
      ) : null}
      {job.goal === "edit" ? null : row(
        "captions",
        <Segmented
          size="md"
          label="Captions"
          value={settings.captions}
          options={[
            { id: "auto", label: "Crackio writes them" },
            { id: "trigger", label: "Trigger only" },
          ]}
          onChange={(v) => set("captions", v as TrainSettings["captions"])}
        />,
      )}
      {more ? (
        <>
          {row("lr", <Slider label="" value={Math.round(settings.lr * 1e5)} min={2} max={50} step={1} format={() => null} onChange={(v) => set("lr", v / 1e5)} hint={["Steady", "Fast, fragile"]} />, settings.lr.toExponential(1).replace("e-", " × 10⁻").replace(/⁻(\d)/, (_, d: string) => `⁻${"⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]}`))}
          {job.goal === "edit" ? null : row("captionDropout", <Slider label="" value={settings.captionDropout} min={0} max={25} step={1} format={() => null} onChange={(v) => set("captionDropout", v)} />, `${settings.captionDropout}%`)}
          {row("offload", <Switch checked={settings.offload} onChange={(v) => set("offload", v)} label={settings.offload ? "On" : "Off"} />)}
          {row("seed", <SeedField value={settings.seed} onChange={(v) => set("seed", v)} />, String(settings.seed))}
        </>
      ) : null}
      <button type="button" onClick={() => setMore(!more)} className="press w-full px-4 py-3 text-left text-[13px] font-semibold text-fog hover:text-paper" aria-expanded={more}>
        {more ? "Hide the fine settings" : "Fine settings: learning rate, pictures without words, memory, seed"}
      </button>
    </div>
  );
}

function SeedField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      defaultValue={value}
      key={value}
      onBlur={(e) => {
        const v = Math.max(0, Math.round(Number(e.target.value) || 0));
        if (v !== value) onChange(v);
      }}
      aria-label="Seed"
      className="field-focus squircle tabular h-9 w-32 rounded-[11px] bg-white/[0.05] px-3 text-[13.5px] text-paper outline-none"
    />
  );
}

/** What the test pictures show: Crackio's two for this goal, or your own. */
function TestPrompts({ job, patch }: { job: TrainJob; patch: (p: TrainPatch) => void }) {
  const [editing, setEditing] = useState(false);
  const shown = testPrompts(job);
  const own = job.testPrompts.length > 0;
  return (
    <div className="px-4 py-3.5">
      <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-paper">
        What the test pictures show
        <button type="button" onClick={() => setEditing(!editing)} className="press h-[22px] rounded-full bg-white/[0.07] px-2 text-[11.5px] font-semibold text-fog hover:text-paper">
          {editing ? "Done" : "Change"}
        </button>
        {own ? (
          <button type="button" onClick={() => patch({ testPrompts: [] })} className="press inline-flex h-[22px] items-center gap-1 rounded-full bg-white/[0.07] px-2 text-[11.5px] font-semibold text-fog hover:text-paper">
            <RotateCcw size={10} /> Crackio&rsquo;s
          </button>
        ) : null}
      </p>
      {editing ? (
        <div className="mt-2 space-y-2">
          {[0, 1].map((i) => (
            <textarea
              key={`${i}-${own}`}
              defaultValue={job.testPrompts[i] ?? TEST_PROMPTS[job.goal][i]}
              rows={2}
              maxLength={400}
              aria-label={`Test picture ${i + 1}`}
              onBlur={(e) => {
                const next = [0, 1].map((k) => (k === i ? e.target.value : (job.testPrompts[k] ?? TEST_PROMPTS[job.goal][k])));
                patch({ testPrompts: next });
              }}
              className="field-focus squircle w-full resize-y rounded-[12px] bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-paper outline-none"
            />
          ))}
          <p className="text-[12px] text-haze">{"{t}"} stands for your trigger word{job.goal === "style" ? "" : " and what it is"}.</p>
        </div>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {shown.map((p, i) => (
            <li key={i} className="max-w-[80ch] text-[12.5px] leading-relaxed text-haze">
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the plan, beside the workbench */

/** Before you start: how long, what it costs, and exactly what will happen, in order. */
export function PlanPanel({ job, options, onStart, starting, uploading }: { job: TrainJob; options: TrainOptions | null; onStart: () => void; starting: boolean; uploading?: boolean }) {
  const settings = shownSettings(job, options);
  const machine = options?.machines.find((m) => m.id === job.machine) ?? null;
  const base = job.base ? (job.base.kind === "custom" ? { name: job.base.file, download: 0 } : (options?.bases.find((b) => b.id === job.base!.family) ?? null)) : null;
  const edit = job.goal === "edit";
  const used = trainable(job.images, job.goal).length;
  const verdict = setVerdict(job.goal, used);
  const est = machine?.estimate ?? null;
  const uses = options?.uses[0]?.name;
  // A model whose files sit behind a licence on Hugging Face downloads only with your token: said here, not after the
  // machine was got ready and the run stopped at the download.
  const needsToken = job.base?.kind === "catalog" && Boolean(options && !options.hfToken && machine?.download && options.bases.find((x) => x.id === job.base!.family)?.gated);
  const missing = uploading ? "Wait for the pictures to finish uploading" : !job.name.trim() || job.name === "New LoRA" ? "Give it a name" : (edit ? !(job.instruction ?? "").trim() : !job.trigger.trim()) ? (edit ? "Say what the change is" : "Give it a trigger word") : !verdict.ok ? `Add at least ${GOAL_IMAGES[job.goal].least} ${edit ? "pairs" : "pictures"}` : !job.base ? "Pick a model" : !job.machine ? "Pick a machine" : machine && machine.fit?.state === "no" ? `${machine.label} can't train this model` : machine && !machine.usable ? (machine.online ? `${machine.label} can't train yet: pick another machine` : `${machine.label} isn't answering`) : needsToken ? "Add your Hugging Face token under Settings → Accounts (and accept the model's terms there)" : null;
  const todo: string[] = [];
  if (machine && !machine.online && machine.kind === "this-computer") todo.push("Start ComfyUI on this computer");
  if (machine?.download) todo.push(`Download ${base?.name ?? "the model"}'s training weights to ${machine.label} (${GB(machine.download)}, once)`);
  // The picture model the test pictures are drawn with: said here, with its size, not found missing at the first saved version.
  const pictures = settings.previews ? (machine?.pictures ?? null) : null;
  if (machine && pictures && !pictures.there && !pictures.none && !pictures.shared) todo.push(`Download ${pictures.name}${pictures.variant ? ` (${pictures.variant})` : ""} to ${machine.label} for the test pictures${pictures.bytes ? ` (${GB(pictures.bytes)}, once)` : ""}`);
  const uncaptioned = job.images.filter((i) => !i.skip && !i.waiting && !i.caption?.trim()).length;
  if (settings.captions === "auto" && uncaptioned && !edit) todo.push(`Write captions for ${uncaptioned} ${uncaptioned === 1 ? "picture" : "pictures"}`);
  if (used) todo.push(`Send ${used} ${edit ? "pairs" : "pictures"} to ${machine?.label ?? "the machine"} and prepare them at up to ${machine?.fit && machine.fit.state !== "no" ? machine.fit.resolution : settings.resolution} px`);
  todo.push(`Train ${settings.steps.toLocaleString("en-US")} steps${machine?.fit?.weights ? ` on the ${machine.fit.weights.toLowerCase()} weights` : ""}${machine?.fit?.offload || settings.offload ? ", part of the model in RAM" : ""}`);
  todo.push(settings.previews ? `Save ${settings.checkpoints} ${settings.checkpoints === 1 ? "version" : "versions"}, with two test pictures each` : `Save ${settings.checkpoints} ${settings.checkpoints === 1 ? "version" : "versions"} along the way`);
  todo.push(`Keep the LoRA on ${machine?.label ?? "the machine"} and on this computer${uses ? `, switched on for ${uses}` : ""}`);
  return (
    <aside aria-label="Before you start" className="squircle rounded-[22px] bg-white/[0.035] p-5 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <h2 className="font-display text-[17px] text-paper">Before you start</h2>
      <div className="mt-4 flex items-end gap-3">
        <Clock size={18} className="mb-1.5 text-daylight" />
        <div>
          <p className="tabular font-display text-[34px] leading-none text-paper">{est ? formatDuration(est.seconds) : "—"}</p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-haze">
            {est ? (
              <>
                Likely {formatDuration(est.low)} to {formatDuration(est.high)}
                {est.cost ? `, about ${money(est.cost)}` : machine?.kind === "this-computer" || machine?.kind === "lan" ? ", free" : ""}.{" "}
                {est.basis === "measured" ? "From a run on this card." : est.basis === "scaled" ? "From a run on another card." : "An estimate until a first run on this card."}
              </>
            ) : (
              "Pick a model and a machine to see how long it takes."
            )}
          </p>
        </div>
      </div>
      {est?.cost && machine?.credit && machine.credit.balance < est.cost * 1.25 ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-[12px] bg-tungsten/10 px-3 py-2 text-[12.5px] leading-snug text-tungsten">
          <CircleAlert size={14} className="mt-px shrink-0" />
          <span>
            {machine.credit.balance <= 0
              ? `Your ${machine.credit.provider === "runpod" ? "RunPod" : "vast.ai"} credit is used up: top up before you start, or the GPU won't run.`
              : `This run needs about ${money(est.cost)} and your ${machine.credit.provider === "runpod" ? "RunPod" : "vast.ai"} credit is ${money(machine.credit.balance)}. Top up first: the GPU stops when it runs out (Crackio pauses the run just before and keeps what's trained).`}
          </span>
        </p>
      ) : null}
      {est ? (
        <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]" title={`Getting ready ${formatDuration(est.parts.ready)} · training ${formatDuration(est.parts.steps)} · test pictures ${formatDuration(est.parts.previews)}`}>
          <span className="bg-white/25" style={{ width: `${(est.parts.ready / est.seconds) * 100}%` }} />
          <span className="bg-daylight" style={{ width: `${(est.parts.steps / est.seconds) * 100}%` }} />
          <span className="bg-daylight/45" style={{ width: `${(est.parts.previews / est.seconds) * 100}%` }} />
        </div>
      ) : null}
      {machine && (machine.download != null || pictures) ? (
        <div className="mt-5">
          <h3 className="text-[12.5px] font-semibold text-fog">{machine.label} needs</h3>
          <ul className="mt-2 space-y-1.5 text-[12.5px] leading-snug">
            {machine.download != null ? (
              <li className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-fog">{base?.name ?? "The model"}&rsquo;s training weights</span>
                <span className={cn("shrink-0 tabular", machine.download ? "text-tungsten" : "text-chroma")}>{machine.download ? `${GB(machine.download)} · downloads first` : "there"}</span>
              </li>
            ) : null}
            {pictures ? (
              <li className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-fog">
                  {pictures.name}
                  {pictures.variant ? ` (${pictures.variant})` : ""} for the test pictures
                </span>
                <span className={cn("shrink-0 tabular", pictures.there ? "text-chroma" : pictures.shared ? "text-haze" : "text-tungsten")}>
                  {pictures.there ? "there" : pictures.none ? "no version runs here" : pictures.shared ? "comes with the weights" : `${GB(pictures.bytes)} · downloads first`}
                </span>
              </li>
            ) : null}
          </ul>
          {pictures && !pictures.there && !pictures.shared ? (
            <p className="mt-2 text-[12px] leading-relaxed text-haze">
              {pictures.none ? "Without one, this run draws no test pictures. " : "Crackio picks the smallest version that runs there. "}
              <Link href={`/settings/tools?machine=${encodeURIComponent(machine.id)}&tool=image`} className="font-semibold text-fog underline-offset-2 hover:text-paper hover:underline">
                Choose the picture model
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      <h3 className="mt-5 text-[12.5px] font-semibold text-fog">What will happen</h3>
      <ol className="mt-2 space-y-2">
        {todo.map((t, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-snug text-fog">
            <span className="tabular mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10.5px] font-bold text-haze">{i + 1}</span>
            <span>{t}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[12px] leading-relaxed text-haze">You can pause any time and carry on later: what&rsquo;s trained is kept. If something goes wrong, Crackio tries to fix it first and tells you what it did.</p>
      <button
        type="button"
        onClick={onStart}
        disabled={Boolean(missing) || starting}
        className="press lip squircle mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-spike text-[14px] font-bold uppercase tracking-[0.04em] text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi disabled:pointer-events-none disabled:opacity-40"
      >
        {starting ? <LoaderCircle size={16} className="animate-spin" /> : null}
        Start training
      </button>
      {missing ? <p className="mt-2 text-center text-[12.5px] text-tungsten">{missing} first.</p> : null}
    </aside>
  );
}
