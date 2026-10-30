import { Focus, Hand, Lock, MoveDown, MoveHorizontal, MoveUp, Plane, RotateCcw, RotateCw, ScanEye, ZoomIn, ZoomOut } from "lucide-react";

/**
 * Camera moves and paces in plain words, each with the phrasing video models follow best and a sample clip
 * (/assets/video/cam-<id>.mp4, pace-<id>.mp4). The same list as the Video tool's.
 */
export const MOVES = [
  { id: "static", label: "Locked off", icon: Lock, phrase: "The camera stays perfectly still on a tripod.", caption: "The frame never moves; only the scene does." },
  { id: "push", label: "Push in", icon: ZoomIn, phrase: "The camera slowly pushes in toward the subject.", caption: "Moves closer for intimacy and tension." },
  { id: "pull", label: "Pull out", icon: ZoomOut, phrase: "The camera slowly pulls back to reveal more of the scene.", caption: "Backs away to reveal where we are." },
  {
    id: "orbit-l",
    label: "Orbit left",
    icon: RotateCcw,
    phrase: "The camera arcs smoothly to the left around the subject (counter-clockwise seen from above), keeping them centered as the background slides left.",
    caption: "Circles the subject to the left.",
  },
  {
    id: "orbit-r",
    label: "Orbit right",
    icon: RotateCw,
    phrase: "The camera arcs smoothly to the right around the subject (clockwise seen from above), keeping them centered as the background slides right.",
    caption: "Circles the subject to the right.",
  },
  { id: "pan", label: "Pan", icon: MoveHorizontal, phrase: "The camera pans slowly across the scene.", caption: "Turns side to side from one spot." },
  { id: "tilt", label: "Tilt up", icon: MoveUp, phrase: "The camera tilts up from the ground to the subject.", caption: "Turns upward, ground to face to sky." },
  { id: "crane", label: "Crane up", icon: MoveDown, phrase: "The camera cranes up and rises above the scene.", caption: "Rises high above for the big picture." },
  { id: "handheld", label: "Handheld", icon: Hand, phrase: "Handheld camera with subtle natural shake, documentary feel.", caption: "Natural shake, like a person holding it." },
  { id: "dolly-zoom", label: "Dolly zoom", icon: Focus, phrase: "A dolly zoom: the camera moves back while zooming in, warping the background.", caption: "The vertigo effect: the world stretches." },
  {
    id: "fpv",
    label: "Fly-through",
    icon: Plane,
    phrase: "A smooth FPV drone fly-through: the camera flies forward past the subject and on through the scene, while the subject stays where they are.",
    caption: "Flies past the subject and on into the scene.",
  },
  {
    id: "pov",
    label: "POV",
    icon: ScanEye,
    phrase:
      "First-person POV shot: the camera is the eyes of the main character (or whoever the prompt names), so we see exactly what they see as they move, at their own eye height, with the natural sway of their steps and head; their own hands, arms or body enter the edge of the frame when natural, and they are never seen from outside.",
    caption: "The camera becomes the character's own eyes.",
  },
] as const;

export type MoveId = (typeof MOVES)[number]["id"];

export const PACES = [
  { id: "subtle", label: "Slow", phrase: "Gentle, minimal motion.", caption: "Barely moving: hair and light, nothing else." },
  { id: "natural", label: "Normal", phrase: "", caption: "Real-life pace, like the moment really happened." },
  { id: "dynamic", label: "Dynamic", phrase: "Energetic, dynamic motion.", caption: "Big, energetic movement and quick camera work." },
] as const;

export type PaceId = (typeof PACES)[number]["id"];

export const SAMPLES = "/assets/video";
