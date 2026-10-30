"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useModels } from "@/lib/hooks/use-models";
import {
  AudioLines,
  AudioWaveform,
  Check,
  ChevronDown,
  Clapperboard,
  Code2,
  CornerDownLeft,
  Download,
  Eye,
  FileCode2,
  FileText,
  Film,
  FolderOpen,
  Globe,
  ImagePlus,
  Layers,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Music2,
  PackageCheck,
  Paperclip,
  Play,
  Plus,
  ScanEye,
  Scissors,
  ScrollText,
  Sparkles,
  Square,
  Trash,
  TriangleAlert,
  Type,
  Wand2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { AppIcon } from "@/components/ui/ToolTile";
import { Popover, MenuItem } from "@/components/ui/Popover";
import { ScrollRow } from "@/components/ui/ScrollRow";
import { ModelPicker } from "@/components/models/ModelPicker";
import { AspectGlyph } from "@/components/ui/AspectGlyph";
import { ChipButton, GLASS_CHIP } from "@/components/dashboard/ComposerControls";
import { CompositionPlayer, type PlayerComposition } from "./CompositionPlayer";
import { Prose } from "./Prose";
import { cn } from "@/lib/cn";

type Attachment = { url: string; kind: "image" | "video" | "audio" | "file"; name: string; width?: number; height?: number; file?: string };
type LogEntry =
  | { id: string; kind: "note"; text: string; at: number }
  | { id: string; kind: "step"; tool: string; title: string; status: "running" | "done" | "error" | "stopped"; detail?: string; files?: string[]; at: number; endedAt?: number };
type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
  attachments?: Attachment[];
  generationId?: string;
  log?: LogEntry[];
  output?: { name: string; url: string; kind: "video" | "image" };
  compositionId?: string;
  createdAt: number;
};
type ProjectFile = {
  name: string;
  kind: "image" | "video" | "audio" | "text" | "other";
  url: string;
  poster?: string;
  width?: number;
  height?: number;
  duration?: number;
  bytes: number;
  source: string;
  compositionId?: string;
  createdAt: number;
};
type Composition = PlayerComposition & { createdAt: number; file?: string };
type Project = { id: string; title: string; updatedAt: number; messages: Message[]; compositions: Composition[]; files?: ProjectFile[] };
type Job = { status: "queued" | "running" | "done" | "error"; progress?: number; stage?: string; error?: string; output?: string; modelName?: string };
type ProjectSummary = { id: string; title: string; updatedAt: number };

const ASPECTS = ["auto", "16:9", "9:16", "1:1", "4:5", "21:9"] as const;
type Aspect = (typeof ASPECTS)[number];
const ASPECT_HINT: Record<Aspect, string> = { auto: "Motion decides", "16:9": "Landscape", "9:16": "Reels, Stories", "1:1": "Square", "4:5": "Feed", "21:9": "Cinema" };

const IDEAS = [
  {
    title: "Ad from a photo",
    body: "Attach a product shot; get a 15 s ad with shots, type and sound.",
    icon: ImagePlus,
    prompt: "Make a premium 15-second ad from the product photo I attached: three generated shots that keep the product exact, bold kinetic type, a confident end card, and sound.",
  },
  {
    title: "Trailer from clips",
    body: "Attach your footage; get a cut with titles and music beats.",
    icon: Clapperboard,
    prompt: "Cut the clips I attached into a 30-second trailer: strongest moments first, cuts on the beat, cinematic titles and a closing card.",
  },
  { title: "Lyric video", body: "Attach a song and lyrics; get synced kinetic type.", icon: Music2, prompt: "Make a lyric video for the song I attached, using the lyrics file, with kinetic typography synced to the vocals." },
  {
    title: "Kinetic launch",
    body: "Describe a product; get type, graphics and sound made in code.",
    icon: Type,
    prompt: "Make a 15-second launch film for a note-taking app called Quill: bold kinetic typography, clean animated UI moments, a confident sound design made in code, and the name at the end.",
  },
];

const TOOL_ICON: Record<string, typeof Film> = {
  ideas: Lightbulb,
  plan: ListChecks,
  generate_image: ImagePlus,
  generate_video: Clapperboard,
  render_html: Code2,
  ffmpeg: Scissors,
  capture_web: Globe,
  download: Download,
  transcript: ScrollText,
  render_audio: AudioWaveform,
  image_map: Layers,
  write_file: FileCode2,
  look: Eye,
  list_files: FolderOpen,
  review: ScanEye,
  finish: PackageCheck,
};

const live = (j?: Job) => j?.status === "queued" || j?.status === "running";
const seconds = (s?: number) => (s === undefined ? "" : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
const fileKey = (name: string) => `file:${name}`;

async function listProjects() {
  const res = await fetch("/api/motion/projects", { cache: "no-store" });
  return ((await res.json()) as { projects: ProjectSummary[] }).projects;
}

async function readProject(id: string) {
  const res = await fetch(`/api/motion/projects/${id}`, { cache: "no-store" });
  return res.ok ? ((await res.json()) as { project: Project; jobs: Record<string, Job> }) : null;
}

/**
 * Motion: an agent with real tools. It generates images and clips on your GPU or Comfy key, designs motion
 * graphics as code, edits with ffmpeg, checks its own work and renders on this computer. Laid out like Director and
 * Storyboard: the piece plays on the stage, the glass bar under it is Home's, and the conversation (every step as it
 * happens) and the project's files share the panel on the right. Turns keep running if you leave, and you can cancel them.
 */
export function MotionAgent() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [picked, setPicked] = useState<{ key: string; over: string } | null>(null);
  const [aspect, setAspect] = useState<Aspect>("auto");
  const [tab, setTab] = useState<"chat" | "files">("chat");

  const loadProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    return list;
  }, []);

  const loadProject = useCallback(async (id: string) => {
    const data = await readProject(id);
    if (data) {
      setProject(data.project);
      setJobs(data.jobs);
    }
    return data;
  }, []);

  // Open the most recent project.
  useEffect(() => {
    void listProjects().then((list) => {
      setProjects(list);
      if (list[0]) setProjectId((id) => id ?? list[0].id);
    });
  }, []);

  // Follow the open project, quickly while a turn is running.
  const running = Object.values(jobs).some(live);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const pull = () =>
      void readProject(projectId).then((data) => {
        if (!alive || !data) return;
        setProject(data.project);
        setJobs(data.jobs);
      });
    pull();
    const t = setInterval(pull, running ? 1200 : 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, running]);

  const files = project?.files ?? [];
  const latestAgent = [...(project?.messages ?? [])].reverse().find((m) => m.role === "agent");
  const latestJob = latestAgent?.generationId ? jobs[latestAgent.generationId] : undefined;

  // The stage shows the newest delivery (or the newest file) until you pick something else;
  // a new delivery takes the stage again.
  const lastOutput = [...(project?.messages ?? [])].reverse().find((m) => m.output)?.output;
  const legacy = project?.compositions.filter((c) => !c.file) ?? [];
  const auto = lastOutput ? fileKey(lastOutput.name) : files.length ? fileKey(files.at(-1)!.name) : legacy.length ? `comp:${legacy.at(-1)!.id}` : "";
  const selected = picked && picked.over === auto ? picked.key : auto;
  const open = (key: string) => setPicked({ key, over: auto });

  async function send(input: { text: string; attachments: Attachment[]; aspect: Aspect; model: string }) {
    let id = projectId;
    if (!id) {
      const res = await fetch("/api/motion/projects", { method: "POST" });
      id = ((await res.json()) as { project: Project }).project.id;
      setProjectId(id);
    }
    const res = await fetch(`/api/motion/projects/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as { project?: Project; error?: string };
    if (!data.project) throw new Error(data.error ?? "Couldn't send that.");
    setProject(data.project);
    setTab("chat");
    void loadProject(id);
    void loadProjects();
  }

  function newProject() {
    setProjectId(null);
    setProject(null);
    setJobs({});
    setPicked(null);
  }

  async function removeProject(id: string) {
    await fetch(`/api/motion/projects/${id}`, { method: "DELETE" });
    const list = await loadProjects();
    if (id === projectId) {
      setProject(null);
      setJobs({});
      setPicked(null);
      setProjectId(list[0]?.id ?? null);
    }
  }

  const outputs = new Set((project?.messages ?? []).flatMap((m) => (m.output ? [m.output.name] : [])));

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4 lg:h-dvh">
      {/* Like Storyboard's: the project on the left, what's happening in the middle, the finished piece on the right. */}
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2">
        <ProjectSwitcher
          projects={projects}
          current={project}
          onPick={(id) => (setProjectId(id), setPicked(null))}
          onRemove={removeProject}
          onNew={newProject}
        />
        <div className="flex min-w-0 flex-1 justify-center">
          <AnimatePresence>{latestAgent?.generationId && live(latestJob) ? <TurnPill key="turn" job={latestJob!} id={latestAgent.generationId} /> : null}</AnimatePresence>
        </div>
        <button
          onClick={newProject}
          className="press inline-flex h-10 items-center gap-1.5 rounded-btn px-3.5 text-[13px] font-semibold text-fog shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04] hover:text-paper"
        >
          <Plus size={14} /> New
        </button>
        {lastOutput ? (
          <a
            href={lastOutput.url}
            download={lastOutput.name}
            className="lip press inline-flex h-10 items-center gap-2 rounded-btn bg-spike px-4 text-[13px] font-bold text-spike-ink [--lip:var(--color-spike-lip)] hover:bg-spike-hi"
          >
            <Download size={15} /> Download
          </a>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* The stage, with Home's glass bar floating over its foot. */}
        <div className="relative flex min-h-[78dvh] min-w-0 flex-1 flex-col lg:min-h-0">
          <Stage project={project} files={files} selected={selected} job={latestJob} jobId={latestAgent?.generationId} />
          <div className="absolute inset-x-3 bottom-3 z-20 sm:inset-x-5 sm:bottom-5">
            <Composer busy={live(latestJob)} onSend={send} aspect={aspect} setAspect={setAspect} />
          </div>
        </div>

        <SidePanel tab={tab} setTab={setTab} files={files.length + legacy.length}>
          {tab === "chat" ? (
            <Thread project={project} jobs={jobs} files={files} selected={selected} onOpen={open} />
          ) : (
            <FilesPanel files={files} legacy={legacy} outputs={outputs} selected={selected} onOpen={open} />
          )}
        </SidePanel>
      </div>
    </div>
  );
}

/** The running turn, in the top bar: what Motion is doing now, and a way to stop it. */
function TurnPill({ job, id }: { job: Job; id: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-w-0 max-w-full items-center gap-2.5 rounded-full bg-white/[0.04] py-1 pl-3.5 pr-1 shadow-[inset_0_0_0_1px_var(--color-line)]"
    >
      <span className="motion-dots shrink-0" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="truncate text-[12.5px] font-medium text-paper">{job.stage ?? "Queued"}</span>
      <span className="hidden shrink-0 text-[11.5px] text-haze sm:inline">Keeps running if you leave</span>
      <CancelButton id={id} />
    </motion.div>
  );
}

function ProjectSwitcher({
  projects,
  current,
  onPick,
  onRemove,
  onNew,
}: {
  projects: ProjectSummary[];
  current: Project | null;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <Popover
      placement="bottom-start"
      panelClassName="w-[300px] p-1.5"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          className="press flex h-10 min-w-0 max-w-[min(340px,60vw)] items-center gap-2 rounded-btn pl-1.5 pr-2.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04] aria-expanded:bg-white/[0.04]"
        >
          <AppIcon glyph="/icons/motion.png" hue="var(--color-tool-motion)" size={26} className="shrink-0" />
          <span className="truncate text-[13.5px] font-semibold">{current?.title ?? "New project"}</span>
          <ChevronDown size={14} className="shrink-0 text-haze" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu">
          <MenuItem
            onSelect={() => {
              onNew();
              close();
            }}
          >
            <Plus size={13} /> New project
          </MenuItem>
          {projects.length ? <div className="my-1 h-px bg-line" /> : null}
          <div className="max-h-[320px] overflow-y-auto">
            {projects.map((p) => (
              <div key={p.id} className="group flex items-center">
                <MenuItem
                  selected={p.id === current?.id}
                  onSelect={() => {
                    onPick(p.id);
                    close();
                  }}
                >
                  <span className="truncate">{p.title}</span>
                </MenuItem>
                <button onClick={() => onRemove(p.id)} className="grid size-7 shrink-0 place-items-center rounded-md text-haze opacity-0 hover:text-tally group-hover:opacity-100" aria-label={`Delete ${p.title}`}>
                  <Trash size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ---------------------------------------------------------------- Side panel */

/** The right panel: the conversation, or the project's files (Storyboard's file bin), one at a time. */
function SidePanel({ tab, setTab, files, children }: { tab: "chat" | "files"; setTab: (t: "chat" | "files") => void; files: number; children: ReactNode }) {
  return (
    <aside className="surface flex h-[78dvh] min-h-0 flex-col overflow-hidden rounded-panel lg:h-auto lg:w-[400px] lg:shrink-0 2xl:w-[440px]">
      <div className="flex h-14 shrink-0 items-center border-b border-line px-3">
        <div role="tablist" aria-label="Panel" className="flex h-9 flex-1 rounded-chip bg-white/[0.03] p-0.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
          {(
            [
              ["chat", "Conversation", MessageSquare],
              ["files", "Files", FolderOpen],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("relative flex flex-1 items-center justify-center gap-1.5 rounded-[10px] text-[12.5px] font-semibold transition-colors", tab === id ? "text-paper" : "text-fog hover:text-paper")}
            >
              {tab === id ? (
                <motion.span layoutId="motion-panel-tab" className="absolute inset-0 rounded-[10px] bg-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.25)]" transition={{ type: "spring", bounce: 0.18, duration: 0.4 }} />
              ) : null}
              <Icon size={13} className="relative" />
              <span className="relative">{label}</span>
              {id === "files" && files ? <span className="tabular relative text-haze">{files}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {children}
    </aside>
  );
}

/* ---------------------------------------------------------------- Thread */

function Thread({
  project,
  jobs,
  files,
  selected,
  onOpen,
}: {
  project: Project | null;
  jobs: Record<string, Job>;
  files: ProjectFile[];
  selected: string;
  onOpen: (key: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = project?.messages.at(-1);
  const pulse = `${project?.messages.length ?? 0}:${last?.log?.length ?? 0}:${last?.text.length ?? 0}`;
  // Newer browsers return a promise from scrollIntoView; an effect may only return a cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [pulse]);

  if (!project || !project.messages.length) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-8 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-[16px] bg-white/[0.04] text-haze shadow-[inset_0_0_0_1px_var(--color-line)]">
            <MessageSquare size={20} />
          </span>
          <p className="mt-3 text-[14px] font-semibold">Your conversation with Motion</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-haze">Its plan, every step it takes and what it makes show up here as it works. Ask for changes the same way.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
      {project.messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex flex-col items-end gap-1.5">
            {m.attachments?.length ? (
              <div className="flex max-w-[88%] flex-wrap justify-end gap-1.5">
                {m.attachments.map((a) => (
                  <Thumb key={a.url} a={a} size={56} onClick={a.file ? () => onOpen(fileKey(a.file!)) : undefined} />
                ))}
              </div>
            ) : null}
            {m.text ? <p className="max-w-[88%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] bg-white/[0.07] px-3.5 py-2.5 text-[13.5px] leading-relaxed">{m.text}</p> : null}
          </div>
        ) : (
          <AgentTurn key={m.id} m={m} job={m.generationId ? jobs[m.generationId] : undefined} files={files} project={project} selected={selected} onOpen={onOpen} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}

function AgentTurn({
  m,
  job,
  files,
  project,
  selected,
  onOpen,
}: {
  m: Message;
  job?: Job;
  files: ProjectFile[];
  project: Project;
  selected: string;
  onOpen: (key: string) => void;
}) {
  const log = m.log ?? [];
  const legacy = m.compositionId ? project.compositions.findIndex((c) => c.id === m.compositionId) : -1;
  const output = m.output ? files.find((f) => f.name === m.output!.name) : undefined;
  // The delivery itself shows as the card below, not as a step.
  const shown = log.filter((e) => e.kind === "note" || e.tool !== "finish");
  let notes = 0;
  return (
    <div className="flex gap-2.5">
      <AppIcon glyph="/icons/motion.png" hue="var(--color-tool-motion)" size={24} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-2">
          {shown.map((e) =>
            e.kind === "note" ? (
              <Prose key={e.id} text={e.text} className={cn("leading-relaxed", notes++ === 0 ? "text-[13.5px] text-paper" : "text-[12.5px] text-fog")} />
            ) : (
              <Step key={e.id} e={e} files={files} selected={selected} onOpen={onOpen} />
            ),
          )}
        </div>

        {job?.status === "error" && job.error === "Cancelled." ? (
          <p className="text-[12.5px] leading-relaxed text-haze">Stopped. Everything made so far is still in the project.</p>
        ) : job?.status === "error" ? (
          <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-tally">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {job.error}
          </p>
        ) : null}

        {job && live(job) ? (
          <p className="flex items-center gap-2 pt-0.5 text-[12px] text-fog">
            <span className="motion-dots shrink-0" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="truncate">{job.stage ?? "Queued"}</span>
          </p>
        ) : null}

        {m.text ? <Prose text={m.text} className="text-[13.5px] leading-relaxed text-paper" /> : null}

        {m.output ? <OutputCard name={m.output.name} url={m.output.url} file={output} active={selected === fileKey(m.output.name)} onOpen={() => onOpen(fileKey(m.output!.name))} /> : null}

        {legacy >= 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => onOpen(`comp:${m.compositionId}`)}
              className={cn("press inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold", selected === `comp:${m.compositionId}` ? "bg-white/[0.12] text-paper" : "bg-white/[0.05] text-fog hover:text-paper")}
            >
              <Film size={12} /> v{legacy + 1} · {project.compositions[legacy].duration}s
            </button>
            {job?.output ? (
              <a href={job.output} download className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 text-[11.5px] font-semibold text-fog hover:text-paper">
                <Download size={12} /> MP4
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Step({ e, files, selected, onOpen }: { e: Extract<LogEntry, { kind: "step" }>; files: ProjectFile[]; selected: string; onOpen: (key: string) => void }) {
  const Icon = TOOL_ICON[e.tool] ?? Wand2;
  const made = (e.files ?? []).map((n) => files.find((f) => f.name === n)).filter((f): f is ProjectFile => Boolean(f));
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }} className="relative">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "relative grid size-[23px] shrink-0 place-items-center rounded-[8px] shadow-[inset_0_0_0_1px_var(--color-line)]",
            e.status === "error" ? "bg-[#2a1416] text-tally" : e.status === "running" ? "bg-[#1b1f33] text-[var(--color-tool-motion)]" : "bg-[#1c1922] text-fog",
          )}
        >
          <Icon size={12} />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", e.status === "running" ? "font-semibold text-paper" : "font-medium text-fog")}>{e.title}</span>
        {e.status === "running" ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin text-[var(--color-tool-motion)]" />
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular text-haze">
            {e.endedAt ? seconds((e.endedAt - e.at) / 1000) : null}
            {e.status === "done" ? <Check size={13} className="text-chroma" /> : e.status === "error" ? <TriangleAlert size={12} className="text-tally" /> : <Square size={10} className="text-haze" />}
          </span>
        )}
      </div>
      {e.detail ? <p className={cn("mt-0.5 line-clamp-2 pl-[33px] text-[11.5px] leading-snug", e.status === "error" ? "text-tally/90" : "text-haze")}>{e.detail}</p> : null}
      {made.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[33px]">
          {made.slice(0, 8).map((f) => (
            <FileTile key={f.name} f={f} size={46} active={selected === fileKey(f.name)} onClick={() => onOpen(fileKey(f.name))} />
          ))}
        </div>
      ) : null}
    </motion.div>
  );
}

function OutputCard({ name, url, file, active, onOpen }: { name: string; url: string; file?: ProjectFile; active: boolean; onOpen: () => void }) {
  const ratio = file?.width && file?.height ? file.width / file.height : 16 / 9;
  const still = file?.poster ?? (file?.kind === "image" ? file.url : undefined);
  return (
    <div className="pt-0.5">
      <button
        onClick={onOpen}
        className={cn("group relative block w-full overflow-hidden rounded-[14px] bg-black", active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line-strong)]")}
        style={{ aspectRatio: Math.max(ratio, 0.8), maxHeight: 260 }}
      >
        {still ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={still} alt="" className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.03]" />
        ) : (
          <video src={`${url}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 size-full object-cover" />
        )}
        {file?.kind !== "image" ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-11 place-items-center rounded-full bg-white/90 text-[#16131b] shadow-[0_8px_24px_-6px_rgb(0_0_0/0.6)] transition-transform group-hover:scale-105">
              <Play size={17} className="translate-x-px" fill="currentColor" />
            </span>
          </span>
        ) : null}
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 text-left text-[11.5px] text-white">
          <span className="truncate font-semibold">{name}</span>
          <span className="shrink-0 tabular text-white/75">{[file?.duration ? seconds(file.duration) : "", file?.width ? `${file.width}×${file.height}` : ""].filter(Boolean).join(" · ")}</span>
        </span>
      </button>
      <div className="mt-1.5 flex items-center gap-1.5">
        <a href={url} download={name} className="press inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 text-[11.5px] font-semibold text-fog hover:text-paper">
          <Download size={12} /> Download
        </a>
      </div>
    </div>
  );
}

function CancelButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/generations/${id}/cancel`, { method: "POST" });
      }}
      disabled={busy}
      className="press inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white/[0.08] px-2.5 text-[11.5px] font-semibold text-paper hover:bg-tally/80 disabled:opacity-50"
    >
      <X size={11} /> {busy ? "Cancelling" : "Cancel"}
    </button>
  );
}

/* ---------------------------------------------------------------- Files */

const FILE_TABS = [
  { id: "all", label: "All", test: () => true },
  { id: "image", label: "Pictures", test: (f: ProjectFile) => f.kind === "image" },
  { id: "video", label: "Clips", test: (f: ProjectFile) => f.kind === "video" },
  { id: "audio", label: "Sound", test: (f: ProjectFile) => f.kind === "audio" },
  { id: "text", label: "Code", test: (f: ProjectFile) => f.kind === "text" || f.kind === "other" },
] as const;

/** Storyboard's file bin: everything the project made or was given, newest first, by kind. */
function FilesPanel({
  files,
  legacy,
  outputs,
  selected,
  onOpen,
}: {
  files: ProjectFile[];
  legacy: Composition[];
  outputs: Set<string>;
  selected: string;
  onOpen: (key: string) => void;
}) {
  const [kind, setKind] = useState<(typeof FILE_TABS)[number]["id"]>("all");
  const tab = FILE_TABS.find((t) => t.id === kind) ?? FILE_TABS[0];
  const list = [...files].sort((a, b) => b.createdAt - a.createdAt).filter(tab.test);
  if (!files.length && !legacy.length) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-8 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-[16px] bg-white/[0.04] text-haze shadow-[inset_0_0_0_1px_var(--color-line)]">
            <FolderOpen size={20} />
          </span>
          <p className="mt-3 text-[14px] font-semibold">No files yet</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-haze">What you attach and everything Motion makes (pictures, clips, sound, code and the final cut) lands here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-3">
        {FILE_TABS.map((t) => {
          const n = t.id === "all" ? files.length : files.filter(t.test).length;
          if (t.id !== "all" && !n) return null;
          return (
            <button
              key={t.id}
              onClick={() => setKind(t.id)}
              className={cn("press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-semibold", kind === t.id ? "bg-white/[0.1] text-paper" : "text-fog hover:text-paper")}
            >
              {t.label} <span className="tabular text-haze">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="scroll-thin grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto p-3">
        {list.map((f) => (
          <FileCard key={f.name} f={f} final={outputs.has(f.name)} active={selected === fileKey(f.name)} onClick={() => onOpen(fileKey(f.name))} />
        ))}
        {kind === "all"
          ? legacy.map((c, i) => (
              <button
                key={c.id}
                onClick={() => onOpen(`comp:${c.id}`)}
                className={cn(
                  "press grid aspect-[4/3] place-items-center rounded-[12px] bg-white/[0.04] text-[12px] font-semibold",
                  selected === `comp:${c.id}` ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[inset_0_0_0_1px_var(--color-line)]",
                )}
              >
                <span className="flex items-center gap-1.5 text-fog">
                  <Film size={13} /> Version {i + 1}
                </span>
              </button>
            ))
          : null}
      </div>
    </div>
  );
}

/** One file in the bin: its picture (or a clip's frame), what it is, and how long. */
function FileCard({ f, final, active, onClick }: { f: ProjectFile; final: boolean; active: boolean; onClick: () => void }) {
  const still = f.kind === "image" ? f.url : f.poster;
  return (
    <button
      onClick={onClick}
      title={f.name}
      className={cn(
        "press group relative aspect-[4/3] overflow-hidden rounded-[12px] bg-apple text-left",
        active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line-strong)] hover:shadow-[0_0_0_1px_rgb(255_255_255/0.3)]",
      )}
    >
      {still ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={still} alt="" loading="lazy" className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-[var(--ease-out-quint)] group-hover:scale-[1.04]" />
      ) : f.kind === "video" ? (
        <video src={`${f.url}#t=0.3`} muted playsInline preload="metadata" className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className={cn("absolute inset-0 grid place-items-center", f.kind === "audio" ? "bg-gradient-to-br from-[#7aa2ff]/25 to-[#f0abfc]/20 text-paper" : "text-haze")}>
          {f.kind === "audio" ? <AudioLines size={22} /> : <FileText size={22} />}
        </span>
      )}
      {final ? (
        <span className="absolute left-1.5 top-1.5 rounded-full bg-spike px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.06em] text-spike-ink">Final</span>
      ) : f.source === "upload" || f.source === "download" ? (
        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-px text-[9.5px] font-semibold text-white">{f.source === "upload" ? "Yours" : "Web"}</span>
      ) : null}
      {f.duration && (f.kind === "video" || f.kind === "audio") ? (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/65 px-1 py-px font-mono text-[9.5px] text-white">{seconds(f.duration)}</span>
      ) : null}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-5 text-[10.5px] font-medium text-white/90">{f.name}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- Stage */

function Stage({ project, files, selected, job, jobId }: { project: Project | null; files: ProjectFile[]; selected: string; job?: Job; jobId?: string }) {
  const [liveView, setLiveView] = useState(false);
  const file = selected.startsWith("file:") ? files.find((f) => f.name === selected.slice(5)) : undefined;
  const comp = selected.startsWith("comp:")
    ? project?.compositions.find((c) => c.id === selected.slice(5))
    : file?.compositionId && liveView
      ? project?.compositions.find((c) => c.id === file.compositionId)
      : undefined;
  const showing = Boolean(comp || file);

  return (
    <section className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel bg-[#120f17] shadow-[inset_0_0_0_1px_var(--color-line)]">
      {/* Motion's own light low behind the glass bar, so the bar reads as glass even on an empty stage. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(90%_55%_at_50%_112%,rgb(111_149_255/0.26),transparent_70%),radial-gradient(45%_35%_at_18%_100%,rgb(240_171_252/0.12),transparent_70%)]"
      />

      {showing ? (
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          {file ? (
            <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
              <span className="truncate font-semibold text-paper">{file.name}</span>
              <span className="shrink-0 tabular text-haze">{[file.width ? `${file.width}×${file.height}` : "", file.duration ? seconds(file.duration) : ""].filter(Boolean).join(" · ")}</span>
            </span>
          ) : (
            <span className="text-[12.5px] font-semibold text-paper">Live preview</span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {file?.compositionId ? (
              <div className="flex items-center gap-1 rounded-full bg-white/[0.05] p-0.5">
                {(["mp4", "live"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setLiveView(t === "live")}
                    className={cn("relative h-7 rounded-full px-3 text-[12px] font-semibold transition-colors", (t === "live") === liveView ? "text-paper" : "text-fog hover:text-paper")}
                  >
                    {(t === "live") === liveView ? <motion.span layoutId="motion-view" className="absolute inset-0 rounded-full bg-white/[0.12]" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} /> : null}
                    <span className="relative">{t === "live" ? "Live" : "Video"}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {file ? (
              <a href={file.url} download={file.name} className="press grid size-8 place-items-center rounded-full text-fog hover:bg-white/[0.06] hover:text-paper" aria-label={`Download ${file.name}`} title="Download">
                <Download size={15} />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {showing ? (
          // The piece sits above the glass bar, never under it.
          <div className="absolute inset-x-4 bottom-[178px] top-0 sm:inset-x-6 sm:bottom-[150px]">
            {comp ? <CompositionPlayer composition={comp} className="absolute inset-0" /> : <Viewer f={file!} />}
          </div>
        ) : (
          <StageEmpty job={job} />
        )}

        <AnimatePresence>
          {job && live(job) && jobId && showing ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="absolute inset-x-0 top-2 mx-auto flex w-fit max-w-[92%] items-center gap-3 rounded-full border border-white/15 bg-black/65 py-1.5 pl-3 pr-1.5"
            >
              <LoaderCircle size={14} className="shrink-0 animate-spin text-[var(--color-tool-motion)]" />
              <span className="truncate text-[12px] font-medium text-paper">{job.stage ?? "Working"}</span>
              <CancelButton id={jobId} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

/**
 * The stage is a fixed box, and media is sized to fit it whole from the file's own dimensions, so a
 * 1080x1920 clip never pushes the page taller and a video doesn't start at its poster's size.
 */
function Fitted({ ratio, children }: { ratio: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.min(e.contentRect.width, e.contentRect.height * ratio);
      setSize({ w, h: w / ratio });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio]);
  return (
    <div ref={box} className="absolute inset-0 flex items-center justify-center">
      {size ? <div style={{ width: size.w, height: size.h }}>{children}</div> : null}
    </div>
  );
}

function Viewer({ f }: { f: ProjectFile }) {
  const box = "absolute inset-0 flex items-center justify-center";
  const frame = "block size-full rounded-[14px] bg-black object-contain shadow-[0_30px_80px_-30px_rgb(0_0_0/0.8)]";
  const ratio = f.width && f.height ? f.width / f.height : 16 / 9;
  if (f.kind === "video") {
    return (
      <Fitted ratio={ratio}>
        <video key={f.url} src={f.url} poster={f.poster} controls autoPlay loop playsInline className={frame} />
      </Fitted>
    );
  }
  if (f.kind === "image") {
    return (
      <Fitted ratio={ratio}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={f.url} src={f.url} alt={f.name} className={frame} />
      </Fitted>
    );
  }
  if (f.kind === "audio") {
    return (
      <div className={box}>
        <div className="w-full max-w-[460px] rounded-[18px] bg-white/[0.04] p-6 text-center shadow-[inset_0_0_0_1px_var(--color-line)]">
          <span className="mx-auto grid size-14 place-items-center rounded-[16px] bg-gradient-to-br from-[#7aa2ff]/30 to-[#f0abfc]/25 text-paper">
            <AudioLines size={24} />
          </span>
          <p className="mt-3 truncate text-[14px] font-semibold">{f.name}</p>
          <audio key={f.url} src={f.url} controls className="mt-4 w-full" />
        </div>
      </div>
    );
  }
  return <TextViewer f={f} />;
}

function TextViewer({ f }: { f: ProjectFile }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(f.url)
      .then((r) => r.text())
      .then((t) => alive && setText(t.slice(0, 40_000)))
      .catch(() => alive && setText(""));
    return () => {
      alive = false;
    };
  }, [f.url]);
  return (
    <div className="scroll-thin absolute inset-0 overflow-auto rounded-[14px] bg-black/40 p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-fog">{text ?? "Loading…"}</pre>
    </div>
  );
}

/** An empty stage: what Motion is, and four pieces to start from (each fills the bar); or the turn getting going. */
function StageEmpty({ job }: { job?: Job }) {
  if (live(job)) {
    return (
      <div className="grid h-full place-items-center pb-[150px]">
        <div className="max-w-[380px] text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-[18px] bg-white/[0.04] shadow-[inset_0_0_0_1px_var(--color-line)]">
            <LoaderCircle size={22} className="animate-spin text-[var(--color-tool-motion)]" />
          </div>
          <p className="mt-4 text-[15px] font-semibold">{job?.stage ?? "Getting started"}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-haze">Every picture, clip and render lands in Files as Motion makes it, and the finished piece plays here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="scroll-thin absolute inset-0 overflow-y-auto px-4 sm:px-8">
      <div className="mx-auto flex min-h-full max-w-[760px] flex-col justify-center pb-[190px] pt-10 text-center sm:pb-[170px]">
        <h1 className="font-display text-[40px] leading-[1.02] sm:text-[56px]">What should we make?</h1>
        <p className="mx-auto mt-3 max-w-[60ch] text-[14.5px] leading-relaxed text-fog">
          Motion plans each piece and builds it in code: type, graphics, 3D, camera moves and sound. It makes pictures and clips on your GPU or your Comfy key only
          where they&apos;re needed, cuts with ffmpeg and checks its own work before it delivers. Attach photos, clips, music or scripts, or paste a link.
        </p>
        <div className="mt-7 grid gap-2.5 text-left sm:grid-cols-2">
          {IDEAS.map((idea) => (
            <button
              key={idea.title}
              onClick={() => window.dispatchEvent(new CustomEvent("motion:prompt", { detail: idea.prompt }))}
              className="press group flex items-start gap-3 text-left rounded-[18px] bg-white/[0.035] p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-white/[0.06]"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[rgb(111_149_255/0.14)] text-[var(--color-tool-motion)] transition-transform duration-300 ease-[var(--ease-out-quint)] group-hover:scale-105">
                <idea.icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-paper">{idea.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-haze">{idea.body}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FileTile({ f, size, active, onClick }: { f: ProjectFile; size: number; active?: boolean; onClick: () => void }) {
  const still = f.kind === "image" ? f.url : f.poster;
  return (
    <button
      onClick={onClick}
      title={f.name}
      className={cn(
        "press group relative shrink-0 overflow-hidden rounded-[10px] bg-apple text-left",
        active ? "shadow-[0_0_0_2px_var(--color-spike)]" : "shadow-[0_0_0_1px_var(--color-line-strong)] hover:shadow-[0_0_0_1px_rgb(255_255_255/0.3)]",
      )}
      style={{ width: size, height: size }}
    >
      {still ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={still} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : f.kind === "video" ? (
        <video src={`${f.url}#t=0.3`} muted playsInline preload="metadata" className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className={cn("absolute inset-0 grid place-items-center", f.kind === "audio" ? "bg-gradient-to-br from-[#7aa2ff]/25 to-[#f0abfc]/20 text-paper" : "text-haze")}>
          {f.kind === "audio" ? <AudioLines size={15} /> : <FileText size={15} />}
        </span>
      )}
    </button>
  );
}

function Thumb({ a, size, onRemove, onClick }: { a: Attachment; size: number; onRemove?: () => void; onClick?: () => void }) {
  const body: ReactNode =
    a.kind === "image" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={a.url} alt="" className="size-full object-cover" />
    ) : a.kind === "video" ? (
      <video src={`${a.url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" />
    ) : (
      <span className={cn("grid size-full place-items-center px-1 text-center", a.kind === "audio" ? "bg-gradient-to-br from-[#7aa2ff]/25 to-[#f0abfc]/20" : "")}>
        <span className="flex flex-col items-center gap-0.5">
          {a.kind === "audio" ? <AudioLines size={15} /> : <FileText size={15} />}
          <span className="line-clamp-1 max-w-full break-all text-[8.5px] text-haze">{a.name}</span>
        </span>
      </span>
    );
  return (
    <span className="group relative block overflow-hidden rounded-[10px] bg-apple shadow-[0_0_0_1px_var(--color-line-strong)]" style={{ width: size, height: size }} title={a.name}>
      {onClick ? (
        <button onClick={onClick} className="block size-full" aria-label={`Open ${a.name}`}>
          {body}
        </button>
      ) : (
        body
      )}
      {a.kind === "video" ? <Film size={11} className="pointer-events-none absolute bottom-1 left-1 text-white drop-shadow" /> : null}
      {onRemove ? (
        <button onClick={onRemove} className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100" aria-label={`Remove ${a.name}`}>
          <X size={10} />
        </button>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------- Composer */

function uploadKind(item: { kind?: string }, file: File): Attachment["kind"] {
  if (item.kind === "video" || item.kind === "audio" || item.kind === "file") return item.kind;
  return file.type.startsWith("image/") ? "image" : "file";
}

/**
 * Home's prompt bar, in Motion: the same smoked glass, the same chips (attach, the model library, the shape) and the
 * same big button. Enter sends; while a turn runs, what you send waits for it.
 */
function Composer({
  busy,
  onSend,
  aspect,
  setAspect,
}: {
  busy: boolean;
  onSend: (input: { text: string; attachments: Attachment[]; aspect: Aspect; model: string }) => Promise<void>;
  aspect: Aspect;
  setAspect: (a: Aspect) => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [model, setModel] = useState("auto");
  // Motion drives its tools itself: the small open model on your GPU can't, so it isn't offered here.
  const { models } = useModels();
  const brains = useMemo(() => models.filter((m) => m.kind === "text" && m.family !== "comfy-local-text").map((m) => m.id), [models]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onIdea = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      area.current?.focus();
    };
    window.addEventListener("motion:prompt", onIdea);
    return () => window.removeEventListener("motion:prompt", onIdea);
  }, []);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 200)}px`;
  }, [text]);

  async function add(files: File[]) {
    for (const file of files.slice(0, 24)) {
      setUploading((n) => n + 1);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/uploads", { method: "POST", body });
        const data = (await res.json()) as { items?: { url: string; width?: number; height?: number; kind?: string }[]; error?: string };
        const item = data.items?.[0];
        if (!item) throw new Error(data.error ?? "Upload failed");
        setAttachments((a) => [...a, { url: item.url, kind: uploadKind(item, file), name: file.name, width: item.width, height: item.height }]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function submit() {
    if (sending || uploading || (!text.trim() && !attachments.length)) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ text, attachments, aspect, model });
      setText("");
      setAttachments([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const empty = !text.trim() && !attachments.length;

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void add(Array.from(e.dataTransfer.files));
      }}
    >
      <div data-dragging={dragging || undefined} className="smoked-glass squircle relative flex flex-col gap-2 rounded-[26px] p-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          {attachments.length || uploading ? (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachments.map((a) => (
                <Thumb key={a.url} a={a} size={52} onRemove={() => setAttachments((list) => list.filter((x) => x.url !== a.url))} />
              ))}
              {Array.from({ length: uploading }, (_, i) => (
                <span key={i} className="skeleton size-[52px] rounded-[10px]" />
              ))}
            </div>
          ) : null}
          <label className="sr-only" htmlFor="motion-prompt">
            Describe the piece
          </label>
          <textarea
            id="motion-prompt"
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void add(files);
              }
            }}
            rows={2}
            placeholder={busy ? "Ask for a change, or queue the next piece…" : "Describe anything: an ad from my photos, a trailer from my clips, a lyric video, an explainer…"}
            className="block min-h-[60px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[16px] leading-relaxed text-paper outline-none [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%_-_8px),transparent)] [scrollbar-color:rgb(255_255_255/0.16)_transparent] [scrollbar-width:thin] placeholder:text-haze"
          />
          <input
            ref={input}
            type="file"
            accept="image/*,video/*,audio/*,.srt,.ass,.vtt,.txt,.json,.csv,.md,.lrc"
            multiple
            hidden
            onChange={(e) => {
              void add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {/* The settings keep one line and their full labels at any width: past what fits they scroll sideways. */}
          <ScrollRow className="-mb-0.5 -mt-1" trackClassName="gap-1.5 px-1">
            <ChipButton onClick={() => input.current?.click()} title="Attach photos, clips, sound or text">
              <Paperclip size={15} />
              Attach
              {attachments.length ? <span className="tabular text-haze">{attachments.length}</span> : null}
            </ChipButton>
            <ModelPicker kind="text" value={model} onChange={setModel} variant="chip" chipClassName={GLASS_CHIP} surface="glass" placement="top-start" library only={brains} fits={(m) => m.family !== "comfy-local-text"} />
            <Popover
              placement="top-start"
              trigger={({ open, toggle }) => (
                <ChipButton onClick={toggle} aria-expanded={open} aria-haspopup="menu" title="The piece's shape" className="pr-2.5">
                  {aspect === "auto" ? <Wand2 size={14} className="text-haze" /> : <AspectGlyph id={aspect} max={13} />}
                  {aspect === "auto" ? "Any shape" : aspect}
                  <ChevronDown size={13} className="shrink-0 text-haze" />
                </ChipButton>
              )}
            >
              {(close) => (
                <div role="menu">
                  {ASPECTS.map((a) => (
                    <MenuItem
                      key={a}
                      selected={a === aspect}
                      onSelect={() => {
                        setAspect(a);
                        close();
                      }}
                      hint={ASPECT_HINT[a]}
                    >
                      {a === "auto" ? <Wand2 size={13} /> : <AspectGlyph id={a} />} {a === "auto" ? "Any shape" : a}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
            <span className="hidden items-center gap-1.5 px-2 text-[12.5px] text-haze xl:inline-flex">
              <Sparkles size={13} className="text-[var(--color-tool-motion)]" /> Plans, makes, cuts and checks
            </span>
          </ScrollRow>
        </div>

        <button
          type="button"
          onClick={() => (empty ? area.current?.focus() : void submit())}
          disabled={sending || uploading > 0}
          className="lip squircle flex h-14 shrink-0 flex-col items-center justify-center gap-1 rounded-[20px] bg-spike px-6 text-spike-ink transition-[background-color,transform,box-shadow] duration-150 [--lip-glow:0_10px_32px_-10px_rgb(255_91_46/0.5)] [--lip:var(--color-spike-lip)] hover:bg-spike-hi hover:[--lip-glow:0_12px_38px_-10px_rgb(255_91_46/0.62)] disabled:cursor-not-allowed disabled:opacity-60 sm:h-auto sm:min-h-[98px] sm:w-[150px] sm:self-stretch"
        >
          {sending ? <LoaderCircle size={20} className="animate-spin" /> : <span className="font-display text-[22px] leading-none">{busy ? "Send" : "Make"}</span>}
          <span className="tabular hidden items-center gap-1 text-[11.5px] font-bold opacity-75 sm:flex">
            {busy ? "Next in line" : aspect === "auto" ? "Any shape" : aspect} <CornerDownLeft size={11} />
          </span>
        </button>
      </div>
      {error ? <p className="mt-2 px-3 text-[12px] text-tally">{error}</p> : null}
    </div>
  );
}
