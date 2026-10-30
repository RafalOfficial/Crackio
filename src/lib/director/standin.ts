import type { ElementKind, Pose, SceneElement } from "./types";

export type { Pose };

/**
 * Stand-ins: what the image model sees in place of each subject. A photo cut-out turned in 3D is a
 * flat card (a face seen from the side becomes a squashed sticker), and an edit model keeps what it's
 * given. So the frame sent to the model shows every subject as a plain colored figure with real 3D
 * shape (a mannequin, a car, a dog, a box) standing exactly where the subject stands, turned the way
 * it faces. The color ties it to its own reference picture, which goes along separately and clean.
 */

/** Distinct, nameable colors, in cast order. Names are what the prompt calls them. */
export const STANDIN_COLORS = [
  { name: "magenta", hex: "#ff2fb3" },
  { name: "cyan", hex: "#19d3ff" },
  { name: "yellow", hex: "#ffd21a" },
  { name: "green", hex: "#2ed46e" },
  { name: "blue", hex: "#3b6cff" },
  { name: "red", hex: "#ff3b3b" },
  { name: "purple", hex: "#9a5bff" },
  { name: "orange", hex: "#ff8a1f" },
] as const;

export function standInColor(index: number) {
  return STANDIN_COLORS[((index % STANDIN_COLORS.length) + STANDIN_COLORS.length) % STANDIN_COLORS.length];
}

/** The stand-in color of an element: its place in the cast list. */
export function colorOf(elements: SceneElement[], id: string) {
  return standInColor(Math.max(0, elements.findIndex((e) => e.id === id)));
}

/** What the stand-in looks like, by kind: "the magenta figure", "the cyan car shape". */
export function standInNoun(kind: ElementKind) {
  return { person: "figure", animal: "animal shape", vehicle: "car shape", product: "block", object: "block" }[kind];
}

/** Every pose a body can take, in words a planner can choose from (Arrange). */
export const POSES: { id: Pose; plain: string }[] = [
  { id: "standing", plain: "standing, relaxed" },
  { id: "walking", plain: "walking, mid-stride" },
  { id: "running", plain: "running" },
  { id: "sitting", plain: "sitting on a chair, bench or step" },
  { id: "lying", plain: "lying on their back" },
  { id: "kneeling", plain: "kneeling" },
  { id: "riding", plain: "riding: astride a motorbike, bicycle or horse, leaning into it, hands forward on the bars or reins" },
  { id: "crouching", plain: "crouching low" },
  { id: "jumping", plain: "jumping, in the air" },
  { id: "waving", plain: "waving one hand up" },
  { id: "pointing", plain: "pointing ahead with one arm" },
  { id: "holding", plain: "holding something in front of them (a phone, a cup, a camera, a sign)" },
  { id: "leaning", plain: "leaning back against something" },
  { id: "dancing", plain: "dancing, arms up" },
  { id: "selfie", plain: "taking a selfie: the right arm held out toward the camera, the phone in that hand at eye level" },
];

/** Words for each pose, in a few languages (people write the action however they like); the first that fits wins. */
const POSE_WORDS: [Pose, RegExp][] = [
  ["riding", /\b(rid(e|es|ing)|rode|astride|straddl\w*|cycl(e|es|ing)|biking|on (a|the|his|her|their) (motor ?bike|motorcycle|bike|bicycle|scooter|horse|pony)|jedzie|jad[ąa]c\w*|montad\w*|reitet|f[äa]hrt)\b/i],
  ["lying", /\b(ly|lie|lies|lying|laying|lay|asleep|sleep\w*|sunbath\w*|reclin\w*|le[żz]y|le[żz][ąa]c\w*|tumbad\w*|acostad\w*|liegt|liegend)\b/i],
  ["crouching", /\b(crouch\w*|squat\w*|hunker\w*|kucn\w*|kuca\w*|agachad\w*|hockt)\b/i],
  ["sitting", /\b(sit|sits|sitting|seated|sat|perched|siedz\w*|siada\w*|sentad\w*|sitzt|sitzend)\b/i],
  ["kneeling", /\b(kneel\w*|knelt|kl[ęe]cz\w*|arrodill\w*|kniet)\b/i],
  // Before walking and the arm poses: "walking along taking a selfie" is a selfie (the arm is the shot).
  ["selfie", /\b(selfie\w*|selfik\w*|autofoto\w*|autorretrato\w*)\b/i],
  ["jumping", /\b(jump\w*|leap\w*|hop|hops|hopping|skacz\w*|skok\w*|salt(a|ando)\w*|springt)\b/i],
  ["running", /\b(run|runs|running|ran|sprint\w*|jog\w*|rush\w*|bieg\w*|corr\w*|rennt|laufend)\b/i],
  ["walking", /\b(walk\w*|stroll\w*|strid\w*|step\w*|march\w*|wander\w*|id[zą]\w*|spaceru\w*|camin\w*|geht|gehend)\b/i],
  ["dancing", /\b(danc\w*|ta[ńn]cz\w*|bail\w*|tanzt)\b/i],
  ["waving", /\b(wav(e|es|ing)|macha\w*|salud\w*|winkt)\b/i],
  ["pointing", /\b(point(s|ing)?|pokazuj\w*|señal\w*|zeigt)\b/i],
  ["leaning", /\b(lean\w*|opier\w*|apoyad\w*|lehnt)\b/i],
  ["holding", /\b(hold\w*|carr(y|ies|ying)|drink\w*|sip\w*|reading|texting|scroll\w*|trzyma\w*|sosten\w*|h[äa]lt)\b/i],
];

/** The poses that only move the arms: the shot's words can give them (poseOf). */
const ARM_POSES = new Set<Pose>(["selfie", "waving", "pointing", "holding"]);

/** Leg: how far the thigh swings forward and the knee bends (radians), the foot's pitch (toes down +), its splay. */
export type Leg = { hip: number; knee: number; foot: number; out?: number };
/** Arm: how far it swings forward and out, how much the elbow bends, which way the palm faces. */
export type Arm = { swing: number; out: number; elbow: number; palm?: "in" | "down" };

/** A body's lengths, in body heights (adult averages). */
export const THIGH = 0.22;
export const SHIN = 0.235;
/** The ankle joint over the sole. */
export const ANKLE = 0.045;
export const UPPER_ARM = 0.165;
export const FOREARM = 0.15;

/** Each pose: the upper body's lean forward and the limbs, the -x side (the body's right) first. */
export const BODIES: Record<Pose, { lean: number; legs: [Leg, Leg]; arms: [Arm, Arm] }> = {
  // Weight on one leg, the other easy: a person standing, not a mannequin at attention.
  standing: {
    lean: 0,
    legs: [{ hip: 0.06, knee: 0.12, foot: 0 }, { hip: -0.02, knee: 0.02, foot: 0 }],
    arms: [{ swing: 0.03, out: 0.12, elbow: 0.2 }, { swing: -0.02, out: 0.12, elbow: 0.12 }],
  },
  walking: {
    lean: 0.03,
    legs: [{ hip: 0.32, knee: 0.08, foot: -0.28 }, { hip: -0.3, knee: 0.35, foot: 0.55 }],
    arms: [{ swing: -0.28, out: 0.1, elbow: 0.12 }, { swing: 0.3, out: 0.1, elbow: 0.4 }],
  },
  running: {
    lean: 0.14,
    legs: [{ hip: 0.85, knee: 1.25, foot: 0.15 }, { hip: -0.35, knee: 0.55, foot: 0.75 }],
    arms: [{ swing: -0.45, out: 0.12, elbow: 1.4 }, { swing: 0.6, out: 0.08, elbow: 1.5 }],
  },
  sitting: {
    lean: -0.04,
    legs: [{ hip: 1.5, knee: 1.45, foot: 0, out: 0.07 }, { hip: 1.5, knee: 1.5, foot: 0, out: 0.07 }],
    arms: [{ swing: 0.35, out: 0, elbow: 0.95, palm: "down" }, { swing: 0.35, out: 0, elbow: 0.95, palm: "down" }],
  },
  kneeling: {
    lean: 0,
    legs: [{ hip: 0.12, knee: 1.69, foot: 3, out: 0.04 }, { hip: 0.12, knee: 1.69, foot: 3, out: 0.04 }],
    arms: [{ swing: 0.05, out: 0.12, elbow: 0.25 }, { swing: 0.05, out: 0.12, elbow: 0.25 }],
  },
  lying: {
    lean: 0,
    legs: [{ hip: 0, knee: 0.03, foot: 0.25 }, { hip: 0, knee: 0.03, foot: 0.25 }],
    arms: [{ swing: 0, out: 0.15, elbow: 0.1 }, { swing: 0, out: 0.15, elbow: 0.1 }],
  },
  // Astride: thighs forward and apart round a seat, shins back to the pegs, leaning into the bars, hands on them.
  riding: {
    lean: 0.42,
    legs: [{ hip: 1.15, knee: 1.75, foot: 0.25, out: 0.32 }, { hip: 1.15, knee: 1.75, foot: 0.25, out: 0.32 }],
    arms: [{ swing: 1.05, out: 0.16, elbow: 0.55, palm: "down" }, { swing: 1.05, out: 0.16, elbow: 0.55, palm: "down" }],
  },
  crouching: {
    lean: 0.45,
    legs: [{ hip: 1.95, knee: 2.45, foot: -0.35, out: 0.16 }, { hip: 1.95, knee: 2.45, foot: -0.35, out: 0.16 }],
    arms: [{ swing: 0.7, out: 0.1, elbow: 0.7 }, { swing: 0.7, out: 0.1, elbow: 0.7 }],
  },
  // Knees tucked up in the air, arms flung up.
  jumping: {
    lean: 0.08,
    legs: [{ hip: 0.95, knee: 1.5, foot: 0.7, out: 0.06 }, { hip: 0.75, knee: 1.35, foot: 0.7, out: 0.06 }],
    arms: [{ swing: 0.25, out: 2.3, elbow: 0.25 }, { swing: 0.25, out: 2.3, elbow: 0.25 }],
  },
  waving: {
    lean: 0,
    legs: [{ hip: 0.06, knee: 0.12, foot: 0 }, { hip: -0.02, knee: 0.02, foot: 0 }],
    arms: [{ swing: 0.03, out: 0.12, elbow: 0.2 }, { swing: 0.35, out: 2.45, elbow: 0.45 }],
  },
  pointing: {
    lean: 0.03,
    legs: [{ hip: 0.06, knee: 0.12, foot: 0 }, { hip: -0.02, knee: 0.02, foot: 0 }],
    arms: [{ swing: 0.03, out: 0.12, elbow: 0.2 }, { swing: 1.45, out: 0.12, elbow: 0.05 }],
  },
  holding: {
    lean: 0.02,
    legs: [{ hip: 0.06, knee: 0.12, foot: 0 }, { hip: -0.02, knee: 0.02, foot: 0 }],
    arms: [{ swing: 0.5, out: 0.06, elbow: 1.35 }, { swing: 0.5, out: 0.06, elbow: 1.35 }],
  },
  // Back against a wall or a car: hips forward, shoulders back, one foot crossed in front.
  leaning: {
    lean: -0.16,
    legs: [{ hip: 0.26, knee: 0.1, foot: 0, out: -0.06 }, { hip: 0.1, knee: 0.04, foot: 0, out: 0.04 }],
    arms: [{ swing: -0.25, out: 0.1, elbow: 0.35 }, { swing: -0.25, out: 0.1, elbow: 0.35 }],
  },
  dancing: {
    lean: 0.06,
    legs: [{ hip: 0.5, knee: 0.85, foot: 0.4, out: 0.14 }, { hip: -0.1, knee: 0.12, foot: 0, out: 0.08 }],
    arms: [{ swing: 0.3, out: 2.55, elbow: 0.5 }, { swing: 0.65, out: 1.35, elbow: 1.05 }],
  },
  // A selfie: the right arm (the first) held out toward the camera a little above the eyes, nearly straight, the phone
  // in that hand; the other arm easy.
  selfie: {
    lean: 0.02,
    legs: [{ hip: 0.06, knee: 0.12, foot: 0 }, { hip: -0.02, knee: 0.02, foot: 0 }],
    arms: [{ swing: 1.75, out: 0.35, elbow: 0.25 }, { swing: 0.03, out: 0.12, elbow: 0.2 }],
  },
};

type P3 = [number, number, number];
/** A body's joints at unit height (feet on the floor, facing +z), named as an OpenPose skeleton has them. */
export type Joints = {
  nose: P3;
  neck: P3;
  rShoulder: P3;
  rElbow: P3;
  rWrist: P3;
  lShoulder: P3;
  lElbow: P3;
  lWrist: P3;
  rHip: P3;
  rKnee: P3;
  rAnkle: P3;
  lHip: P3;
  lKnee: P3;
  lAnkle: P3;
  rEye: P3;
  lEye: P3;
  rEar: P3;
  lEar: P3;
};
const joints = new Map<Pose, Joints>();

/**
 * Where a body's joints are in a pose: the same chain the stand-in is built along (StandIn's personParts), grounded on
 * its lowest point, a lying body on its back along +z (Arrange seats riders by its hips: hipHeight).
 */
export function jointsOf(pose: Pose): Joints {
  const hit = joints.get(pose);
  if (hit) return hit;
  const body = BODIES[pose];
  const norm = (p: P3): P3 => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  const along = (a: P3, d: P3, t: number): P3 => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  const legs = body.legs.map((leg, i) => {
    const s = i ? 1 : -1;
    const out = Math.sin((leg.out ?? 0) * s);
    const hip: P3 = [0.055 * s, 0.5, 0];
    const knee = along(hip, norm([out, -Math.cos(leg.hip), Math.sin(leg.hip)]), THIGH);
    const bend = leg.hip - leg.knee;
    return { hip, knee, ankle: along(knee, norm([out, -Math.cos(bend), Math.sin(bend)]), SHIN) };
  });
  // The upper body, built standing and then leaned forward or back from the hips.
  const lean = (p: P3): P3 => {
    const y = p[1] - 0.5;
    return [p[0], y * Math.cos(body.lean) - p[2] * Math.sin(body.lean) + 0.5, y * Math.sin(body.lean) + p[2] * Math.cos(body.lean)];
  };
  const arms = body.arms.map((arm, i) => {
    const s = i ? 1 : -1;
    const shoulder: P3 = [0.097 * s, 0.775, 0];
    const d1 = norm([s * Math.sin(arm.out), -Math.cos(arm.swing) * Math.cos(arm.out), Math.sin(arm.swing) * Math.cos(arm.out)]);
    const elbow = along(shoulder, d1, UPPER_ARM);
    let ahead: P3 = [-d1[0] * d1[2], -d1[1] * d1[2], 1 - d1[2] * d1[2]];
    ahead = Math.hypot(...ahead) < 1e-2 ? [0, 1, 0] : norm(ahead);
    const d2 = norm([d1[0] * Math.cos(arm.elbow) + ahead[0] * Math.sin(arm.elbow), d1[1] * Math.cos(arm.elbow) + ahead[1] * Math.sin(arm.elbow), d1[2] * Math.cos(arm.elbow) + ahead[2] * Math.sin(arm.elbow)]);
    return { shoulder: lean(shoulder), elbow: lean(elbow), wrist: lean(along(elbow, d2, FOREARM)) };
  });
  let j: Joints = {
    nose: lean([0, 0.922, 0.055]),
    neck: lean([0, 0.8, 0]),
    rShoulder: arms[0].shoulder,
    rElbow: arms[0].elbow,
    rWrist: arms[0].wrist,
    lShoulder: arms[1].shoulder,
    lElbow: arms[1].elbow,
    lWrist: arms[1].wrist,
    rHip: legs[0].hip,
    rKnee: legs[0].knee,
    rAnkle: legs[0].ankle,
    lHip: legs[1].hip,
    lKnee: legs[1].knee,
    lAnkle: legs[1].ankle,
    rEye: lean([-0.018, 0.942, 0.042]),
    lEye: lean([0.018, 0.942, 0.042]),
    rEar: lean([-0.044, 0.93, -0.006]),
    lEar: lean([0.044, 0.93, -0.006]),
  };
  const all = (f: (p: P3) => P3) => Object.fromEntries(Object.entries(j).map(([k, p]) => [k, f(p)])) as Joints;
  // On their back along the way they face, centered on their spot.
  if (pose === "lying") j = all(([x, y, z]) => [x, z, 0.5 - y]);
  const floor = pose === "lying" ? Math.min(...Object.values(j).map((p) => p[1])) - 0.07 : Math.min(...Object.values(j).map((p) => p[1])) - ANKLE;
  j = all(([x, y, z]) => [x, y - floor, z]);
  joints.set(pose, j);
  return j;
}

/** How high a body's hips are over its feet in a pose (body heights): what lifts a rider onto a seat. */
export function hipHeight(pose: Pose) {
  const j = jointsOf(pose);
  return (j.rHip[1] + j.lHip[1]) / 2;
}

/** The pose the action describes, for people and animals; standing when it says nothing. */
export function poseOf(el: Pick<SceneElement, "kind" | "action" | "pose"> & { name?: string }, words?: string): Pose {
  if (el.kind !== "person" && el.kind !== "animal") return "standing";
  const own = el.pose && BODIES[el.pose] ? el.pose : POSE_WORDS.find(([, re]) => re.test(el.action ?? ""))?.[0];
  // With no pose or action of their own, the shot's words about them ("Lena is taking a selfie") pose their arms: only
  // the arm poses, which need nothing under them (a "riding" from words alone would straddle thin air).
  const said = !own && !el.action?.trim() && words && el.name && el.name.trim().length > 1 ? words.split(/[.!?\n]+/).filter((s) => s.toLowerCase().includes(el.name!.trim().toLowerCase())).join(". ") : "";
  const fromWords = said ? POSE_WORDS.find(([p, re]) => ARM_POSES.has(p) && re.test(said))?.[0] : undefined;
  const pose = own ?? fromWords ?? "standing";
  // An animal's shape stands, sits or lies.
  if (el.kind === "animal") return pose === "lying" ? "lying" : pose === "sitting" || pose === "kneeling" || pose === "crouching" ? "sitting" : "standing";
  return pose;
}

const KIND_WORDS: [ElementKind, RegExp][] = [
  [
    "vehicle",
    /\b(car|cars|truck|cybertruck|pickup|suv|sedan|coupe|roadster|hatchback|convertible|jeep|van|bus|taxi|cab|limo\w*|tesla|bmw|audi|mercedes|porsche|ferrari|lamborghini|bugatti|mclaren|toyota|honda|ford|mustang|chevrolet|nissan|volkswagen|vw|volvo|kia|hyundai|mazda|subaru|motorbike|motorcycle|moto|scooter|vespa|bike|bicycle|tractor|boat|yacht|ship|plane|jet|helicopter|train|tram|auto|samoch[oó]d\w*|motor|rower|coche|wagen)\b/i,
  ],
  [
    "animal",
    /\b(dog|dogs|puppy|pup|cat|cats|kitten|kitty|horse|pony|bird|parrot|rabbit|bunny|hamster|guinea pig|cow|sheep|goat|pig|fox|wolf|bear|lion|tiger|deer|duck|chicken|owl|eagle|fish|retriever|labrador|poodle|terrier|husky|corgi|pug|bulldog|shepherd|spaniel|beagle|dachshund|chihuahua|pies|psa|piesek|kot|kotek|ko[nń]|ptak|perro|gato|hund|katze)\b/i,
  ],
  [
    "product",
    /\b(bottle|perfume|fragrance|can|sneaker|sneakers|shoe|shoes|boot|boots|watch|phone|iphone|smartphone|headphones|earbuds|bag|handbag|backpack|lipstick|cream|serum|lotion|jar|tube|cup|mug|tumbler|laptop|camera|sunglasses|glasses|cosmetic\w*|product|package|packaging|butelka|perfumy|buty|zegarek|telefon|torebka|kubek)\b/i,
  ],
  [
    "object",
    /\b(chair|sofa|couch|table|desk|lamp|plant|tree|rock|stone|statue|sculpture|guitar|piano|ball|box|crate|barrel|bench|bed|tv|television|vase|clock|sign|krzes[łl]o|st[oó][łl]|lampa|ro[śs]lina|drzewo)\b/i,
  ],
  [
    "person",
    /\b(man|men|woman|women|girl|boy|guy|lady|person|people|model|kid|child|baby|dad|mom|mum|father|mother|brother|sister|friend|me|myself|him|her|actor|actress|dancer|singer|player|mężczyzna|facet|ch[łl]opak|kobieta|dziewczyna|dziecko|hombre|mujer|frau|mann)\b/i,
  ],
];

/**
 * A first guess at what a picture shows, from its name and the shape of its cut-out, until (or
 * unless) a vision model reads it. People are tall, vehicles long and low; anything else stays a person.
 */
export function guessKind(name: string, aspect?: number): ElementKind | null {
  const words = name.replace(/[_\-.]+/g, " ");
  for (const [kind, re] of KIND_WORDS) if (re.test(words)) return kind;
  if (aspect && aspect >= 1.9) return "vehicle";
  return null;
}

/** Sizes of a stand-in, in meters, from the element (its height) and its picture's shape. */
/** Motorbikes, scooters and bicycles: a vehicle on two wheels, whose stand-in is a bike, not a car. */
export const twoWheeled = (el: { kind: SceneElement["kind"]; name?: string }) =>
  el.kind === "vehicle" && /\b(motor ?bikes?|motor ?cycles?|motos?|scooters?|vespas?|mopeds?|dirt ?bikes?|bikes?|bicycles?|cycles?|rowery?|rower)\b/i.test(el.name ?? "");

export function standInSize(el: Pick<SceneElement, "kind" | "height" | "image"> & { name?: string }) {
  const h = el.height;
  const aspect = el.image ? el.image.width / Math.max(1, el.image.height) : 1;
  switch (el.kind) {
    case "vehicle":
      // A motorbike is about as long as two of its heights and narrow; a car three, and wider than it's tall.
      return twoWheeled(el) ? { width: h * 0.6, height: h, length: h * 1.9 } : { width: h * 1.25, height: h, length: h * 3 };
    case "animal":
      return { width: h * 0.42, height: h, length: h * 1.25 };
    case "person":
      return { width: h * 0.3, height: h, length: h * 0.2 };
    default: {
      // Products and objects are usually shot from the front: their picture's width is their width.
      const width = h * Math.min(3, Math.max(0.2, aspect));
      return { width, height: h, length: Math.max(h * 0.25, width * 0.7) };
    }
  }
}
