import type { AspectId } from "@/lib/shot";
import looks from "./looks.json";

/** A recurring character or prop, described once and kept the same in every shot. */
export type BibleEntry = {
  name: string;
  look: string;
  size: string;
  /** What the models call it ("the pigeon", "the woman in the yellow raincoat"): they don't know names. */
  noun?: string;
  /** A few words that tell it apart in a clip, where the models see only the first frame. */
  tag?: string;
};

/**
 * The continuity bible, written while planning: one place, one light, and every character and
 * prop with a fixed look and a real-world size, so nothing changes shape between shots.
 */
export type Bible = {
  /** Where and when: the location and its landmarks, weather, light direction, palette. */
  setting: string;
  characters: BibleEntry[];
  props: BibleEntry[];
  /** How big things are next to each other, as comparisons you can see ("the hamster is about a third of the pigeon's length"). */
  scale?: string;
};

/** The frame's check for AI mistakes (things that couldn't happen in real life). */
export type ShotCheck = {
  status: "pending" | "checking" | "passed" | "fixing" | "fixed" | "flagged" | "skipped";
  /** What was found (and fixed, unless flagged). */
  issues?: string[];
  /** Fix rounds so far: a fixed frame is checked again, up to a limit. */
  round?: number;
  /** The characters whose faces show clearly in the frame, and how to find each one in it. */
  seen?: { name: string; where: string }[];
};

/** A clip's review: did the shot happen, where to cut it, and what a retake should change. */
export type ShotReview = {
  status: "pending" | "reviewing" | "accepted" | "retake" | "flagged" | "skipped";
  /** Where the shot is cut in the clip, in seconds (the clip plays from `in` to `out`). */
  in?: number;
  out?: number;
  /** How good the take is, 1 to 10 (picks the best when every retake falls short). */
  score?: number;
  /** One line on what the clip does, or what went wrong. */
  summary?: string;
  issues?: string[];
  /** What the next take's prompt asks for differently. */
  note?: string;
};

/** One rendered clip of a shot. Retakes keep the earlier ones. */
export type Take = { clip: string; review?: ShotReview; note?: string; at: number };

/** One shot of the film: where the camera is, what's in the first frame, what happens, and how it ends. */
export type Shot = {
  id: string;
  title: string;
  /** Shot size: "Wide", "Medium", "Close-up"… */
  framing: string;
  /** Where the camera is and its one move: "low on the roof behind the hamster, looking past him; static". */
  camera: string;
  /** The first frame: what's in the foreground, middle and background, and which way everyone faces. */
  layout?: string;
  /** What happens, in visible terms. May name characters with @handle. */
  action: string;
  /** Older boards: the opening moment. */
  start?: string;
  /** The held moment the shot ends on, which the next shot starts from. */
  end?: string;
  /** How each character plays it: expressions, gestures, glances, reactions (what keeps them from looking like mannequins). */
  acting?: string;
  /** What the place and the people around them are doing meanwhile. */
  background?: string;
  /** Where everyone and every key prop is when the shot ends ("the watch is in Marlowe's coat pocket; Vance is still at the bar"). */
  state?: string;
  /** "continuous": the same camera keeps rolling from the last frame of the shot before; "cut": a new camera setup. */
  transition?: "cut" | "continuous";
  /** Seconds on screen. */
  duration: number;
  /** The first frame, and how it was made. */
  frame?: string;
  frameFrom?: "drawn" | "bridge" | "continuous";
  check?: ShotCheck;
  /** The take in use, its review, and the cut. */
  clip?: string;
  review?: ShotReview;
  takes?: Take[];
  /** The frame at the cut: the next shot starts from it. */
  outFrame?: string;
  /** What the next take must do differently ("the pigeon launches in the first second"). */
  note?: string;
  /** The next take's prompt, written for its video model from the plan and the start frame (`key` says what it was written from). */
  prompt?: { text: string; key: string; words?: number; dropped?: string; guide?: string };
  /** What the next drawing of the first frame must show differently. */
  frameNote?: string;
  /** Times the first frame was drawn again after its check. */
  redraws?: number;
  /** A cut whose redraw kept the old camera: it's drawn fresh from the place and cast instead. */
  fresh?: boolean;
  /** Generations running for this shot (the frame, its fix, its clip). */
  jobs: { frame?: string; fix?: string; clip?: string };
  /** Renders that failed in a row (they're tried again a couple of times before it stops). */
  failures?: number;
  error?: string;
};

/** What the director did, shown under its reply. */
export type BoardEvent = {
  id: string;
  at: number;
  /** Shot number (1-based) it was about, if any. */
  shot?: number;
  kind: "plan" | "frame" | "check" | "fix" | "clip" | "review" | "retake" | "cut" | "film" | "error" | "note";
  text: string;
};

/** One answer to a question the director asks; for places, a picture of it. */
export type AskOption = { id: string; label: string; detail?: string; image?: string; job?: string; prompt?: string };

/** A question the director asks before making the film, answered with a tap (or in your own words). */
export type Ask = {
  id: string;
  /** "pictures": options shown as images (where it happens); "choice": short options; "approve": the story, ready to shoot. */
  kind: "pictures" | "choice" | "approve";
  /** What it decides: "place", "crowd", "pace", or whatever the story hinges on. */
  key: string;
  question: string;
  options: AskOption[];
  /** The option picked. */
  answer?: string;
};

export type BoardMessage = {
  id: string;
  role: "user" | "director";
  text: string;
  at: number;
  /** The director's work log for this turn. */
  events?: BoardEvent[];
  /** Still answering (planning or reading a change). */
  pending?: boolean;
  /** Questions to answer with a tap. */
  asks?: Ask[];
  /** The story the director proposes (shown as a pitch you approve). */
  treatment?: Treatment;
};

/** The story worked out with you before any shot is planned: who, where, why, and how it pays off. */
export type Treatment = {
  title: string;
  logline: string;
  /** Where and when, and why these people are there. */
  world: string;
  characters: { name: string; role: string; want?: string; look: string }[];
  props?: { name: string; role: string; look: string }[];
  /** The story in beats, setup to payoff. */
  beats: { title: string; what: string }[];
  ending: string;
  tone?: string;
};

/** A picture of someone or something in the film, shown to every frame and clip so they look the same throughout. */
export type KitItem = {
  id: string;
  kind: "character" | "prop" | "place";
  name: string;
  /** What the models call it ("the detective"). */
  noun?: string;
  look?: string;
  image?: string;
  /** The generation drawing it. */
  job?: string;
  error?: string;
  /**
   * The frame a character was pictured again from, the first time they showed clearly: image models
   * seldom draw a reference exactly, so the picture follows who is really on screen from then on.
   */
  from?: string;
  /** Where they are in that frame ("the silver-haired man on the right"). */
  where?: string;
  /** The picture from the frame, waiting to be compared with it before it replaces `image`. */
  draft?: string;
  /** Pictured from the frame a second time (the first one didn't match). */
  retried?: boolean;
};

/** Making the film with you before the shots: your brief, your answers, and the story you approved. */
export type Development = {
  brief: string;
  /** Ask key → the option's label (or "director's choice"). */
  answers: Record<string, string>;
  /** Anything you said along the way. */
  notes: string[];
  /** The chosen place's picture: it opens the film and anchors its look. */
  place?: string;
  treatment?: Treatment;
  approved?: boolean;
  /** What the director is working on for you right now, and the reply bubble it will fill. */
  waiting?: "develop" | "treatment";
  reply?: string;
  /** Straight to the story with no questions (you said "just make it"). */
  auto?: boolean;
};

export type Storyboard = {
  id: string;
  /**
   * 3: the director chain (each shot starts from the last frame of the one before, every frame
   * and clip checked, clips cut on the beat). 2: planned with a bible, frames drawn first.
   */
  version?: 2 | 3;
  title: string;
  /** The scene as it was described, in any language. */
  scene: string;
  /** Kept for boards planned before the bible. */
  setting?: string;
  bible?: Bible;
  /** Version 2: the location with nobody in it. */
  plate?: string;
  aspect: AspectId;
  look: LookId;
  /** Version 3: how long the film should run, in seconds. */
  target?: number;
  /**
   * Version 3: the same words at the end of every frame and every clip, so every shot looks and moves
   * alike. Once the first frame is approved, the style is rewritten from it (`anchor` is that frame).
   */
  locks?: { style: string; motion: string; anchor?: string; capture?: string };
  /** The models that draw the frames and animate the clips (missing: Auto). */
  /** The frame and clip models (Auto when missing), and the frames' resolution (one of the frame model's choices). */
  models?: { image?: string; video?: string; resolution?: string };
  shots: Shot[];
  /** "developing": working out the film with you (questions, then the story to approve) before any shot is planned. */
  status: "developing" | "planning" | "ready" | "error";
  dev?: Development;
  /** The cast, props and place as pictures, made before the first frame. */
  kit?: KitItem[];
  /** Stopped by you: nothing new starts until you say go. */
  paused?: boolean;
  error?: string;
  jobs?: { plate?: string };
  /** Version 3: you and the director. */
  messages?: BoardMessage[];
  /** While planning: what else the plan was asked to take in, and the reply waiting for it. */
  planNote?: string;
  planReply?: string;
  /** The stitched video, and the job making it. */
  final?: string;
  finalJob?: string;
  /** Times putting the film together failed in a row (it stops retrying on its own after two). */
  filmFailures?: number;
  createdAt: number;
  updatedAt: number;
};

export type LookId = string;
export type Look = { id: LookId; label: string; caption: string; prompt: string; plan: string; preview: string };

export const LOOKS: Look[] = looks.looks;
export const lookById = (id: string) => LOOKS.find((l) => l.id === id) ?? LOOKS[0];
export const lookPreview = (id: string) => `/assets/storyboard/look-${id}.webp`;

/** The same six shapes as the Video page. */
export const SHAPES: AspectId[] = ["16:9", "21:9", "3:2", "1:1", "2:3", "9:16"];

/** Film lengths you can ask for. */
export const LENGTHS = [15, 30, 45, 60];

/** Output size for the stitched video, per shape. */
export const VIDEO_SIZE: Record<string, [number, number]> = {
  "16:9": [1280, 720],
  "21:9": [1680, 720],
  "3:2": [1080, 720],
  "1:1": [960, 960],
  "4:5": [864, 1080],
  "2:3": [720, 1080],
  "9:16": [720, 1280],
};

/** How long a shot plays in the cut: its trimmed clip, or its planned length until it has one. */
export const screenTime = (s: Shot) => (s.clip && s.review?.out !== undefined ? Math.max(0.5, s.review.out - (s.review.in ?? 0)) : s.duration);

/** A shot is finished when its clip is accepted and the frame at the cut is saved. */
export const shotDone = (s: Shot) => Boolean(s.clip && s.outFrame && (s.review?.status === "accepted" || s.review?.status === "flagged" || s.review?.status === "skipped"));
