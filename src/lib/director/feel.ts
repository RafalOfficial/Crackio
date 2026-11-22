"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * How the Director's camera feels, every number in one place (the challenge winner's rule: feel is tuned by hand, by
 * name, and never scattered). Speeds scale with how far you are from what you look at, so they feel right at any size.
 */
export const FEEL = {
  /** Degrees the view swings round its center per pixel dragged. */
  orbitPerPx: 0.3,
  /** A mouse notch (100 px of scroll) moves you this factor closer to what's under the pointer. */
  wheelStep: 1.2,
  /** Pixels of a pinch (ctrl+wheel) that make one lens step. */
  pinchPx: 8,
  /** Never closer than this to what the pointer is over, meters. */
  closest: 0.15,
  /** Never farther than this from the point you look at, meters. */
  farthest: 60,
  /** W A S D: this share of the distance to the point you look at per second, within these (m/s); Shift goes `fast` times quicker. */
  keySpeed: 0.5,
  keySpeedMin: 0.4,
  keySpeedMax: 6,
  fast: 4,
  /** Arrow keys turn this many degrees a second. */
  turnPerSecond: 75,
  /** The fence: how far from the place's middle you can go, meters. */
  fence: 45,
  /** The lowest the view goes, meters over the floor. */
  floor: 0.08,
  /** One-shot moves (Home, focus, frame) glide this long, seconds; drags and keys follow 1:1. */
  ease: 0.4,
  /** Your eyes' lens in the Set tab: vertical degrees. */
  fovMin: 20,
  fovMax: 100,
  fovDefault: 55,
  fovStep: 2,
  /** The Camera's lens, mm (full-frame). */
  focalMin: 14,
  focalMax: 200,
  /** One wheel or pinch step changes the Camera's lens by this factor. */
  focalStep: 1.06,
  /** Never straight up or down: the view would flip. */
  pitchLimit: 88,
  /** A press that moves less than this is a click (it picks or lets go), pixels. */
  clickSlop: 4,
} as const;

/** Orbit first: drag swings round what you look at (like Sketchfab). Look first: drag turns your head (like Street View). */
export type Scheme = "orbit" | "look";
/** How the place is drawn: 3D (near things measured), picture + floor, or picture only (never moves). */
export type PlaceLook = "3d" | "floor" | "picture";

type Feel = { scheme: Scheme; place: PlaceLook; lab: boolean };

/** The feel you picked, remembered in this browser. `lab`: the panel that switches them is open. */
/**
 * The place is drawn in 3D by default: the photo itself on its depth (Stage3D PhotoSet, the challenge winner's "3D
 * World"), so the camera moves round what's in it and a kept shot's model fills what the photo never saw. Version 2 had
 * moved everyone onto the flat floor while shots were drawn through a ControlNet, whose depth guide the torn 3D place
 * broke (a cafe: flat takes); kept shots edit the picture itself. Version 3 moves everyone onto 3D.
 */
export const useFeel = create<Feel>()(
  persist((): Feel => ({ scheme: "orbit", place: "3d", lab: false }), {
    name: "crackio:director-feel",
    version: 3,
    migrate: (old) => ({ ...(old as Feel), place: "3d", lab: false }),
  }),
);
