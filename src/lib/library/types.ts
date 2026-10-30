/**
 * Library projects: folders you make in the Library to keep takes apart from everything else.
 * A take is one output of a generation, so a run of four can be split up. A take sits in exactly
 * one place: General (the Library as it always was) or one project.
 */
export type LibraryProject = {
  id: string;
  name: string;
  /** An icon id from PROJECT_ICONS, or "svg:<base64>" for an .svg you uploaded. */
  icon: string;
  /** "#rrggbb"; tints the icon. */
  color: string;
  createdAt: number;
};

export type ProjectInput = Pick<LibraryProject, "name" | "icon" | "color">;

/** One take filed into a project. */
export type Placement = { id: string; index: number; project: string };

/** The folder every take starts in. Not a project: it can't be renamed or deleted. */
export const GENERAL = "general";

export const NAME_MAX = 26;
export const SVG_MAX_BYTES = 24_000;

/** Quick picks; any other color works too. */
export const PROJECT_COLORS = [
  "#ff5b2e",
  "#f2b54b",
  "#e8d35a",
  "#5ad78f",
  "#3fd0c0",
  "#5cc8f2",
  "#6f95ff",
  "#ad94ff",
  "#d784ff",
  "#ff79b8",
  "#ff5c74",
  "#bdb9b3",
];

/** Icons to pick from, with the words that find them. The glyphs are in components/library/project-icons. */
export const PROJECT_ICONS = [
  { id: "folder", words: "folder files general" },
  { id: "sparkles", words: "sparkles magic ai stars new" },
  { id: "star", words: "star favorite best" },
  { id: "heart", words: "heart love favorite" },
  { id: "flame", words: "flame fire hot trending" },
  { id: "zap", words: "zap lightning energy fast" },
  { id: "clapperboard", words: "clapperboard film movie scene take" },
  { id: "film", words: "film movie reel cinema" },
  { id: "video", words: "video camera clip" },
  { id: "camera", words: "camera photo shoot" },
  { id: "aperture", words: "aperture lens photo" },
  { id: "image", words: "image picture photo" },
  { id: "images", words: "images gallery pictures" },
  { id: "palette", words: "palette color art design" },
  { id: "brush", words: "brush paint retouch edit" },
  { id: "wand", words: "wand magic effects edit" },
  { id: "pen-tool", words: "pen design vector draw" },
  { id: "scissors", words: "scissors cut edit" },
  { id: "layers", words: "layers stack composite" },
  { id: "type", words: "type text title font" },
  { id: "music", words: "music song audio" },
  { id: "mic", words: "mic voice podcast audio" },
  { id: "headphones", words: "headphones audio music" },
  { id: "megaphone", words: "megaphone ad campaign marketing" },
  { id: "tv", words: "tv television commercial" },
  { id: "monitor", words: "monitor screen desktop" },
  { id: "smartphone", words: "smartphone phone mobile social reels" },
  { id: "popcorn", words: "popcorn movie cinema" },
  { id: "drama", words: "drama theater masks story" },
  { id: "shopping-bag", words: "shopping bag store product" },
  { id: "package", words: "package product box shipping" },
  { id: "store", words: "store shop brand" },
  { id: "briefcase", words: "briefcase work client business" },
  { id: "building", words: "building office company city" },
  { id: "gift", words: "gift present holiday" },
  { id: "gem", words: "gem diamond jewelry luxury" },
  { id: "crown", words: "crown king queen royal premium" },
  { id: "trophy", words: "trophy win award" },
  { id: "target", words: "target goal aim" },
  { id: "flag", words: "flag milestone" },
  { id: "lightbulb", words: "lightbulb idea concept" },
  { id: "rocket", words: "rocket launch startup space" },
  { id: "users", words: "users people team cast" },
  { id: "user", words: "user person portrait" },
  { id: "smile", words: "smile happy fun" },
  { id: "baby", words: "baby kids family" },
  { id: "paw-print", words: "paw pet animal" },
  { id: "cat", words: "cat pet animal" },
  { id: "dog", words: "dog pet animal" },
  { id: "bird", words: "bird animal nature" },
  { id: "shirt", words: "shirt fashion clothes outfit" },
  { id: "glasses", words: "glasses style eyewear" },
  { id: "globe", words: "globe world travel" },
  { id: "map-pin", words: "map pin place location" },
  { id: "plane", words: "plane travel flight" },
  { id: "car", words: "car auto drive" },
  { id: "bike", words: "bike cycling sport" },
  { id: "mountain", words: "mountain nature landscape outdoors" },
  { id: "waves", words: "waves ocean sea beach water" },
  { id: "sun", words: "sun summer day light" },
  { id: "moon", words: "moon night dark" },
  { id: "cloud", words: "cloud sky weather" },
  { id: "snowflake", words: "snowflake winter snow cold" },
  { id: "leaf", words: "leaf nature green eco" },
  { id: "flower", words: "flower spring bloom" },
  { id: "tree", words: "tree pine christmas forest" },
  { id: "coffee", words: "coffee cafe drink" },
  { id: "pizza", words: "pizza food" },
  { id: "cake", words: "cake birthday party food" },
  { id: "wine", words: "wine drink dinner" },
  { id: "party", words: "party celebration confetti" },
  { id: "ghost", words: "ghost halloween spooky" },
  { id: "skull", words: "skull halloween dark" },
  { id: "gamepad", words: "gamepad game gaming" },
  { id: "dumbbell", words: "dumbbell fitness gym sport" },
  { id: "atom", words: "atom science tech" },
  { id: "bot", words: "bot robot ai" },
  { id: "brain", words: "brain think mind" },
  { id: "bookmark", words: "bookmark save later" },
  { id: "tag", words: "tag label" },
  { id: "archive", words: "archive old storage" },
  { id: "calendar", words: "calendar date schedule" },
] as const;

export type ProjectIconId = (typeof PROJECT_ICONS)[number]["id"];

const ICON_IDS = new Set<string>(PROJECT_ICONS.map((i) => i.id));
const SVG_ICON = /^svg:[A-Za-z0-9+/]+={0,2}$/;

/** "svg:<base64>": an icon someone uploaded. It's only ever drawn as a CSS mask, never put in the page. */
export const isCustomIcon = (icon: string) => icon.startsWith("svg:");

export function isProjectIcon(icon: string) {
  if (ICON_IDS.has(icon)) return true;
  if (!SVG_ICON.test(icon) || icon.length > Math.ceil((SVG_MAX_BYTES * 4) / 3) + 8) return false;
  try {
    return atob(icon.slice(4)).includes("<svg");
  } catch {
    return false;
  }
}

export const isHexColor = (color: string) => /^#[0-9a-f]{6}$/i.test(color);

/** Letters as people count them: "✨" and "👩‍🎤" are one each. */
function graphemes(text: string) {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
}

export const nameLength = (name: string) => graphemes(name).length;

/** Keeps a name within NAME_MAX letters. */
export function clampName(name: string) {
  const letters = graphemes(name);
  return letters.length > NAME_MAX ? letters.slice(0, NAME_MAX).join("") : name;
}

export const cleanName = (name: string) => name.replace(/\s+/g, " ").trim();

/** Why a name can't be used, or null. `taken` holds the other projects' names. */
export function nameProblem(name: string, taken: string[]): string | null {
  const clean = cleanName(name);
  if (!clean) return "Give the project a name.";
  if (nameLength(clean) > NAME_MAX) return `Keep the name to ${NAME_MAX} characters.`;
  const key = clean.toLocaleLowerCase();
  if (key === GENERAL) return "General is where everything else lives. Pick another name.";
  if (taken.some((t) => t.toLocaleLowerCase() === key)) return `You already have a project called “${clean}”.`;
  return null;
}
