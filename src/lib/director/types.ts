import type { AspectId } from "@/lib/shot";

/** What a scene element is. It decides its default size and how the prompt talks about it. */
export type ElementKind = "person" | "animal" | "object" | "product" | "vehicle";

export type SceneElement = {
  id: string;
  kind: ElementKind;
  /** The kind was guessed (from the name, the picture's shape or a vision model), not picked: a better guess may replace it. */
  kindAuto?: boolean;
  /** How the person refers to it: "Mila", "my dog", "the sneaker". */
  name: string;
  /** Lifted out of the place photo (its car, a passer-by): it was there, now it stands on set like anything staged. */
  fromPlace?: boolean;
  /**
   * A Cast member: their reference sheet (front, three-quarter and side, full length) is who they are to the model.
   * People and pets come from Cast; `image` is then the sheet's front view, cut out, for the stage.
   */
  cast?: { id: string; handle?: string; sheet?: string; portrait?: string };
  /**
   * What a vision model read in the picture: a short noun ("a matte black Tesla Cybertruck") and what makes it
   * look like itself. Models that see the picture get the noun; models that take words only get it all.
   */
  read?: {
    noun: string;
    identity: string;
    /**
     * From which side the photo shows it, as the photo camera's place around it (degrees): 0 = from the front, 45 = its
     * front-left (it faces image left), 90 = its left side, 180 = behind, negative = its right. The photo card on set is
     * turned by this much, so `yaw` is always where the subject itself faces.
     */
    around?: number;
  };
  /**
   * The picture on set: a cutout (transparent background) when one could be made.
   * `sourceUrl` is the photo as uploaded, sent to the model as the identity reference.
   */
  image?: { url: string; width: number; height: number; cutout: boolean; sourceUrl?: string };
  /**
   * The subject drawn from all around it (cut out, its whole height), by the model you shoot with: the camera view shows
   * the drawing nearest to the side the camera sees, so it looks right from anywhere, back included.
   */
  views?: { around: number; above: number; url: string; width: number; height: number }[];
  /** Free text: what they wear / look like. Optional. */
  look?: string;
  /** Free text: what they're doing. "running toward camera", "holding a coffee". */
  action?: string;
  /** Its body's pose, when set (by Arrange); else read from `action`. */
  pose?: Pose;
  /** Floor position in meters (x: left/right, z: toward/away from the default camera). */
  x: number;
  z: number;
  /** Real-world height in meters. */
  height: number;
  /** Lift off the floor (on a table, flying) in meters. */
  lift: number;
  /** Direction the element faces, degrees. 0 = toward the default camera (+z). */
  yaw: number;
};

/** A body's pose: the stand-in's shape. */
export type Pose =
  | "standing"
  | "walking"
  | "running"
  | "sitting"
  | "lying"
  | "kneeling"
  | "riding"
  | "crouching"
  | "jumping"
  | "waving"
  | "pointing"
  | "holding"
  | "leaning"
  | "dancing"
  | "selfie";

/**
 * How a location photo was taken, recovered from its depth map. The photo is rebuilt as a 3D
 * set seen from this camera: standing at `height` above the floor, `pivot` meters from the spot
 * in the middle of the picture, tilted `pitch` degrees up (+) or down (-) and rolled `roll`.
 */
export type PlaceView = {
  /** Vertical field of view of the photo, degrees. */
  fov: number;
  height: number;
  pitch: number;
  roll: number;
  /** Distance (m) from the camera to the point the photo is centered on. */
  pivot: number;
  /** Nearest and farthest depth in the photo (m), which shape its 3D relief. */
  near: number;
  far: number;
  /** Whether a floor was found. Without one the set is placed at a typical distance. */
  floor: boolean;
};

/**
 * Another photo of the location, taken from the same spot facing another way: its 3D set joins the main one around
 * the main photo's camera, so the place goes on behind and beside the first view.
 */
export type PlacePhoto = {
  url: string;
  width: number;
  height: number;
  view?: PlaceView;
  /** Degrees it looks away from the main photo's direction: 180 = behind it, 90 = to its left, -90 = to its right. */
  turn: number;
  /** The turn was set by hand: adding more photos doesn't spread it. */
  turnSet?: boolean;
};

export type Place = {
  /** Optional photo of the location. `view` appears once its 3D set has been built. */
  image?: { url: string; width: number; height: number; view?: PlaceView };
  /** More photos from the same spot, facing other ways (two back to back, three or four all around). */
  more?: PlacePhoto[];
  /** Words for the location: "rainy side street at night". */
  text: string;
  /** How big the place is relative to the people in it (1 = as measured). */
  scale?: number;
  /** The photo's cars, people and objects were looked for and lifted out onto the set (`image` is then the photo without them). */
  lifted?: boolean;
  /** The place all around the photo's spot as one 360 picture (equirectangular, 21:9: 154 degrees of latitude); see server/world. */
  world?: PlaceWorld;
};

/** How far everything in the world is (server/world-depth): the stage builds it as a place to walk into. */
export type WorldDepth = { url: string; width: number; height: number; rMin: number; eye: number; ceiling: number | null; indoor: boolean; version: number };
/** The world's own light, in the light rig's terms (server/world-depth). */
export type WorldLight = { azimuth: number; elevation: number; softness: number; kelvin: number; sun: boolean };

export type PlaceWorld = {
  url: string;
  width: number;
  height: number;
  depth?: WorldDepth;
  light?: WorldLight;
  /** Its light was put on the set once (after that the light is yours). */
  lit?: boolean;
};

export type CameraRig = {
  /** Degrees around the focus point. 0 = in front of the set (+z side). Positive = to the right. */
  azimuth: number;
  /** Degrees above (+) or below (-) the focus point. */
  elevation: number;
  /** Meters from the focus point. */
  distance: number;
  /** Focal length in mm (full-frame equivalent). */
  focal: number;
  /** f-number. */
  aperture: number;
  /** Dutch tilt, degrees. */
  roll: number;
  /** Height of the focus point above the floor (meters). */
  focusHeight: number;
  /** Element the camera frames; null = scene center. */
  focusId: string | null;
  /**
   * Walking: the point the camera orbits and looks at, carried along ahead of it (at the framed subject's depth, so
   * the focus stays on them) instead of the subject itself. Framing a subject again clears it.
   */
  free?: { x: number; z: number } | null;
};

export type LightRig = {
  /** Key light direction around the subject, degrees, same convention as the camera. */
  azimuth: number;
  /** Key light height, degrees above the horizon. */
  elevation: number;
  /** 0 = hard (bare bulb, noon sun) … 1 = very soft (overcast, big softbox). */
  softness: number;
  /** Color temperature in Kelvin. */
  kelvin: number;
  /** Named mood / time of day preset id, or null for custom. */
  mood: string | null;
};

export type Scene = {
  elements: SceneElement[];
  place: Place;
  camera: CameraRig;
  light: LightRig;
  style: string;
  aspect: AspectId;
  /** Anything else, in the person's own words (any language). */
  notes: string;
};
