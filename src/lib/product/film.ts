/**
 * Product Studio's Video mode: a picture you made in Image mode (or any picture) becomes a short ad.
 *
 * Like the image picks, every pick here is a suggestion to the film director, never a phrase pasted
 * into a prompt: "Creator" + "Excited" + "Snap zoom" means something different for a sports drink at
 * the gym than for a serum in a bathroom. The director (lib/server/product-film) sees the picture and
 * the product, fits each pick to them, writes what the person says, and writes the prompt in the
 * syntax the chosen video model follows best.
 *
 * `brief` is what the director is told; `caption` is the line under the preview. `for` lists the
 * styles an option belongs to (all when missing). `needs` says what a model must be able to do.
 * Previews: public/assets/product/film/<axis>-<id>-<still>.mp4 (scripts/assets/film-previews.mjs).
 */

export type FilmStyleId = "creator" | "lifestyle" | "living" | "hero" | "demo" | "campaign";

/** What an option asks of a video model. */
export type FilmNeed = "sound" | "refs" | "loop";

export type FilmOption<T extends string = string> = {
  id: T;
  label: string;
  caption: string;
  brief: string;
  for?: readonly FilmStyleId[];
  needs?: readonly FilmNeed[];
};

const opt = <T extends string>(o: FilmOption<T>) => o;

const PEOPLE: readonly FilmStyleId[] = ["creator", "lifestyle"];

export const FILM_STYLES = [
  opt({
    id: "creator",
    label: "Creator",
    caption: "A creator talks to camera about it, like a real post.",
    brief:
      "UGC talking video. The person in the picture talks to the camera about the product in their own words, the way a real creator posts it: spontaneous, imperfect, never like an ad or an announcer. They hold, show or use the product while they talk. It must pass as a real phone video someone posted.",
    needs: ["sound"],
  }),
  opt({
    id: "lifestyle",
    label: "Real life",
    caption: "Someone using it in a real moment. No talking to camera.",
    brief:
      "Candid lifestyle clip. The person in the picture uses or wears the product in a real, unposed moment, never performing for the lens and never talking to it. It must feel caught, not staged: real timing, small natural movements, a camera with a person behind it.",
  }),
  opt({
    id: "living",
    label: "Living photo",
    caption: "Your picture comes alive: steam, light, a breeze. Nothing else moves.",
    brief:
      "A living photograph (cinemagraph). The camera stays fixed and everything stays exactly as in the picture: the product, the people, the composition. Only one or two small natural motions bring it alive (steam off a drink, condensation running, a candle flame, light shifting, a breeze in fabric or leaves), slow and real-time, so it could loop on a website banner.",
  }),
  opt({
    id: "hero",
    label: "Hero shot",
    caption: "A premium commercial shot: one slow camera move, perfect light.",
    brief:
      "A high-end commercial product shot, the kind a brand pays a studio for: controlled light, one slow, motivated camera move, the product perfectly true and the clear hero of every frame, one product moment (light gliding across it, a splash, a reveal). Polished, precise, no people unless they're already in the picture.",
  }),
  opt({
    id: "demo",
    label: "Hands-on",
    caption: "Hands open it, use it and show how it works, with crisp sounds.",
    brief:
      "A hands-on product demo, ASMR-style: hands open, use or show the product the way it's really used, close up, every contact sound crisp and close to the mic. Real hands, simple confident movements, counted actions. The product stays true and readable.",
  }),
  opt({
    id: "campaign",
    label: "Campaign",
    caption: "Several of your pictures cut into one fast ad.",
    brief:
      "A short campaign edit made from several of the client's pictures: one shot per picture, each a few seconds with one strong move, cut together in an order that builds. Every shot keeps its own picture's product exactly true.",
  }),
] as const;

export const FILM_CAMERAS = [
  opt({
    id: "auto",
    label: "As in your picture",
    caption: "Filmed the way your picture was taken.",
    brief:
      "Keep the camera the picture was taken with: a selfie stays a selfie (the phone never visible, one free hand), a friend filming stays a friend filming, a propped phone stays still, a mirror stays a mirror. Read the first frame and carry on from it.",
    for: ["creator", "lifestyle"],
  }),
  // Creator: a phone, held by someone.
  opt({
    id: "selfie",
    label: "Selfie",
    caption: "Held at arm's length; the frame moves with them.",
    brief:
      "Front-camera selfie at arm's length. The phone is the camera, so it is never visible. One arm stays stretched toward the lens holding it, which leaves ONE free hand for the product, hair and gestures. The frame sways gently with that arm, dips when they laugh or shrug and drifts back, and their face is never perfectly centered. Wide phone lens, deep focus, everyday phone sharpness.",
    for: ["creator"],
  }),
  opt({
    id: "walk",
    label: "Walk & talk",
    caption: "Talking while walking; the frame bobs with every step.",
    brief:
      "Walking selfie: they walk slowly and talk to the front camera held at arm's length (never visible; one free hand). Every step bobs the frame a little, the arm drifts, the background slides past behind them, and they glance where they're going now and then.",
    for: ["creator"],
  }),
  opt({
    id: "propped",
    label: "Propped up",
    caption: "Phone leaned on something; they lean in and out.",
    brief:
      "The phone is propped up on a table, shelf or counter and nobody holds it: the frame never moves or reframes, so when they lean in their face gets bigger, when they lean back or reach for something they partly leave the frame and come back. Both hands are free.",
    for: ["creator"],
  }),
  opt({
    id: "friend",
    label: "Friend filming",
    caption: "Someone else holds the phone and reacts.",
    brief:
      "A friend films them on a phone from about a meter away, handheld: the friend never appears, but the camera reacts like a person (a beat late to follow a gesture, a small reframe, a slight bounce when the friend laughs). They talk to the friend's camera, now and then glancing just past it at the friend. Both hands are free.",
    for: ["creator"],
  }),
  opt({
    id: "mirror",
    label: "Mirror",
    caption: "Filmed in a mirror, the phone in their hand.",
    brief:
      "A mirror video: we see them in a full-length or bathroom mirror, holding the phone at chest height (the phone is visible in the reflection, its back to us, covering little of the face). They turn a little to show the product or outfit and talk to their reflection. One free hand.",
    for: ["creator"],
  }),
  opt({
    id: "car",
    label: "In the car",
    caption: "The parked-car review everyone recognizes.",
    brief:
      "In the driver's seat of a parked car, filmed on a phone held at arm's length or clipped to the dashboard: seat belt off, daylight through the windshield, a little road noise outside. The car review format: casual, close, honest.",
    for: ["creator"],
  }),
  // Real life: a camera with a person behind it.
  opt({
    id: "handheld",
    label: "Handheld",
    caption: "A friend follows the moment with a phone.",
    brief: "Handheld phone camera held by a friend a couple of meters away: natural sway, a beat late to follow movement, a small reframe now and then. Nobody looks at it.",
    for: ["lifestyle"],
  }),
  opt({
    id: "tripod",
    label: "Tripod",
    caption: "A still camera; they move through the frame.",
    brief: "The camera stands still on a tripod at eye level and never moves; the person moves through the frame, partly leaving it when they would.",
    for: ["lifestyle"],
  }),
  opt({
    id: "pov",
    label: "Their eyes",
    caption: "First person: we see what they see.",
    brief: "First-person POV at their own eye height: we see their own hands and the product as they use it, with the natural sway of their head; they are never seen from outside.",
    for: ["lifestyle", "demo"],
  }),
  // Hero: one slow, controlled move.
  opt({ id: "push", label: "Slow push", caption: "Glides slowly toward the product.", brief: "One slow, steady push-in toward the product on a slider, ending a little closer with the label sharp.", for: ["hero"] }),
  opt({ id: "orbit", label: "Orbit", caption: "Arcs slowly around the product.", brief: "A slow, smooth arc of the camera around the product (about 20 degrees), keeping it centered as the background slides behind it; the product itself never moves or turns. The label faces us at the start or the end.", for: ["hero"] }),
  opt({ id: "macro", label: "Macro", caption: "Slides across its details up close.", brief: "A macro lens sliding slowly across the product's most beautiful details (texture, cap, print, stitching), very shallow focus, ending on the label or logo in focus.", for: ["hero"] }),
  opt({ id: "rise", label: "Rise up", caption: "Rises from the surface to reveal it.", brief: "The camera starts low at the surface and rises smoothly (a pedestal/crane move) to reveal the product, settling at a flattering three-quarter view.", for: ["hero"] }),
  opt({ id: "locked", label: "Locked off", caption: "The camera stays still; the light and motion do the work.", brief: "A locked-off camera that never moves; everything happens in the frame.", for: ["hero"] }),
  // Living photo: barely any move.
  opt({ id: "still", label: "Still camera", caption: "Perfectly still, ready to loop.", brief: "The camera is locked off on a tripod and never moves, not even slightly.", for: ["living"] }),
  opt({ id: "drift", label: "Slow drift", caption: "A barely-there push, like breathing.", brief: "An almost imperceptible slow push-in over the whole clip, as if the picture is breathing.", for: ["living"] }),
  // Hands-on.
  opt({ id: "top", label: "Overhead", caption: "Straight down on the hands and the table.", brief: "Camera directly overhead, looking straight down at the hands and the product on the surface; locked off.", for: ["demo"] }),
  opt({ id: "side", label: "Across the table", caption: "Low, beside the hands, shallow focus.", brief: "Camera low across the table at the hands' height, a 50-85 mm look with shallow focus, small handheld drift.", for: ["demo"] }),
] as const;

export const FILM_HOOKS = [
  opt({ id: "none", label: "Straight in", caption: "Starts mid-moment, no gimmick.", brief: "No gimmick: it starts in the middle of the moment, already going, never on a still pose." }),
  opt({
    id: "zoom",
    label: "Snap zoom",
    caption: "A fast punch-in on the first beat.",
    brief: "Crackio snaps the frame in tight on the first beat in the edit (never ask the model for a zoom). Make that first second land: it opens already mid-word or mid-move, eyes on the lens, energy up.",
    for: ["creator", "lifestyle", "hero", "campaign"],
  }),
  opt({
    id: "lens",
    label: "Into the lens",
    caption: "The product is pushed right up to the lens, then pulled back.",
    brief: "It opens with the product pushed right up to the lens (filling the frame, slightly soft), then pulled back to reveal the person's face or the scene.",
    for: ["creator", "lifestyle", "demo"],
  }),
  opt({
    id: "toss",
    label: "Toss & catch",
    caption: "The product flies in and gets caught.",
    brief: "In the first second the product is tossed into the frame from off-screen and caught cleanly in one hand (one product, the same one, caught by the hand that holds it after).",
    for: ["creator", "lifestyle"],
  }),
  opt({
    id: "wait",
    label: "Wait…",
    caption: "Starts mid-sentence, like you caught them.",
    brief: "A pattern interrupt: the clip starts abruptly, mid-sentence and mid-movement, as if the recording just started (the frame still settling), with a first line like \"wait, wait\" or \"okay no,\" before they get into it.",
    for: ["creator"],
    needs: ["sound"],
  }),
  opt({
    id: "fumble",
    label: "Fumble",
    caption: "Nearly drops it, catches it, laughs.",
    brief: "A tiny blooper hook: in the first second they almost drop the product, catch it, and laugh at themselves before carrying on. One product the whole time.",
    for: ["creator", "lifestyle"],
  }),
  opt({
    id: "sound",
    label: "Sound first",
    caption: "Opens on a crisp product sound: a pop, a crinkle, a tap.",
    brief: "It opens on the product's most satisfying sound, close to the mic and before anything else happens: a cap popping, a pouch crinkling, a lid clicking, a nail tapping glass.",
    for: ["creator", "demo", "hero"],
    needs: ["sound"],
  }),
  opt({
    id: "question",
    label: "Question",
    caption: "Opens on a question the viewer can't ignore.",
    brief: "A spoken hook: the first line, in the first second, is a short question straight into the lens about the viewer's own habit or problem (\"Why does nobody talk about…?\"), eyebrows up; the brand comes after.",
    for: ["creator"],
    needs: ["sound"],
  }),
  opt({
    id: "callout",
    label: "Callout",
    caption: "“If you do this, watch this.”",
    brief: "A spoken hook that calls out exactly who it's for: the first line, in the first second, is \"If you ___, watch this.\" (a specific, recognizable behaviour), said mid-gesture with the product in hand.",
    for: ["creator"],
    needs: ["sound"],
  }),
  opt({
    id: "contrarian",
    label: "Stop buying…",
    caption: "A contrarian line that stops the scroll.",
    brief: "A contrarian spoken hook: the first line, in the first second, said flatly into the lens, is \"Stop buying ___ that ___.\" about the category (never another brand by name); then the product is the answer.",
    for: ["creator"],
    needs: ["sound"],
  }),
  opt({ id: "reveal", label: "Hide & reveal", caption: "The product comes into view from behind or below.", brief: "The product starts hidden (behind their back, below the frame, behind a hand) and is revealed in the first second.", for: ["creator", "lifestyle", "demo"] }),
  opt({ id: "drop", label: "Drop in", caption: "The product drops into frame and lands.", brief: "The product drops into the frame from above and lands with weight on the surface (one bounce at most, a little dust or a splash where it fits), then the shot settles.", for: ["hero", "campaign"] }),
  opt({ id: "lights", label: "Lights on", caption: "Dark, then the light snaps on.", brief: "It opens almost dark, then the key light snaps on (a practical switch, a flash, sunlight from a blind) and the product is suddenly lit.", for: ["hero", "campaign"] }),
] as const;

export const FILM_MOODS = [
  opt({ id: "excited", label: "Excited", caption: "Can't contain it: quick, bright, laughing.", brief: "Excited, not hype: eyebrows up, a quick smile, leans toward the lens, lifts the product a little fast, laughs once mid-sentence; lines said quickly, a little breathless." }),
  opt({ id: "warm", label: "Warm", caption: "Friendly and easy, like talking to a friend.", brief: "Warm: an easy smile that comes and goes, relaxed shoulders, a soft laugh, nods while talking; lines said casually, unhurried." }),
  opt({ id: "calm", label: "Cozy", caption: "Soft-spoken, slow, comfortable.", brief: "Cozy: slow blinks, relaxed shoulders, slow hands, a gentle half-smile, pauses between phrases; lines said softly, smiling." }),
  opt({ id: "honest", label: "Honest", caption: "Plain, matter-of-fact. Credible.", brief: "Honest, matter-of-fact: a steady gaze, small nods, one small shrug, an eyebrow lift on the key point; lines explained plainly, no hype words." }),
  opt({ id: "amazed", label: "Amazed", caption: "Genuinely surprised it works.", brief: "Amazed: eyes widen, the head pulls back a little, then a short disbelieving laugh, looks at the product and back at the lens; the first line starts with a gasp (\"Wait.\" or \"No way.\")." }),
  opt({ id: "whisper", label: "Whisper", caption: "Close to the mic, ASMR-soft.", brief: "Whisper: leans close to the lens (the product near it, not at it), eyes soft, slow careful hands; every line whispered, about two words a second, every product sound close and crisp.", needs: ["sound"] }),
  opt({ id: "secret", label: "Secret", caption: "Lowers her voice, like she's letting you in on it.", brief: "Conspiratorial: a glance to the side as if checking nobody's listening, leans in, lowers the voice, maybe a finger to the lips; the first line in the shape of \"Don't tell anyone, but…\"." }),
  opt({ id: "skeptic", label: "Skeptic → fan", caption: "Doubtful at first, convinced by the end.", brief: "Skeptic turned fan: squints at the label, tilts the head, says the first line doubtfully, tries or looks closely, a pause, then the eyebrows lift and a slow nod; the last line said, surprised, as a concession." }),
  opt({ id: "relieved", label: "Relieved", caption: "Finally, something that works.", brief: "Relieved: lets out a breath, the shoulders drop, a small smile; a line like \"Finally.\" said on the exhale." }),
  opt({ id: "deadpan", label: "Deadpan", caption: "Dry, funny, straight face.", brief: "Deadpan: a still face, a slow blink, a flat gaze into the lens, lines said flatly without smiling, a beat of silence before the punchline, one eyebrow lift at the very end." }),
] as const;

export const FILM_PACES = [
  opt({ id: "calm", label: "Slow & luxe", caption: "Unhurried, quiet, premium.", brief: "Slow and luxurious: unhurried moves, long holds, quiet sound." }),
  opt({ id: "natural", label: "Natural", caption: "Real-life timing.", brief: "Real-life timing, nothing sped up or slowed down." }),
  opt({ id: "punchy", label: "Punchy", caption: "Fast, energetic, made to stop the scroll.", brief: "Punchy and energetic: quick, decisive moves, snappy timing, crisp sounds." }),
] as const;

export const FILM_STORIES = [
  // People.
  opt({ id: "one", label: "One take", caption: "One continuous moment, start to finish.", brief: "One continuous take, no cuts: one moment that unfolds naturally from the first frame to the last.", for: PEOPLE }),
  opt({
    id: "punch",
    label: "Punch-ins",
    caption: "Jump-cut zooms on the key words, edit-style.",
    brief: "Edited like a creator's post: Crackio cuts in tighter on two or three key phrases in the edit (never ask the model for zooms or cuts). Film one continuous take that gives those phrases weight: a beat of pause before each, eyes straight into the lens on it; pick them as the emphasis phrases.",
    for: ["creator"],
  }),
  opt({ id: "show", label: "Show & tell", caption: "Brings it close to the lens to show the details.", brief: "They bring the product close to the lens to show its label and best detail, turn it once in the light, then pull it back.", for: PEOPLE }),
  opt({ id: "use", label: "Tries it", caption: "Uses it on camera: a sip, a spray, it goes on.", brief: "They use the product on camera exactly as it's meant to be used (a sip, a spray, a dab on the cheek, putting it on), showing the beat just before and just after contact rather than the contact itself when it's a mouth or a fine detail.", for: PEOPLE }),
  opt({ id: "before", label: "Before → after", caption: "Starts with the problem, ends with the fix.", brief: "A tiny before-and-after: it starts on the problem the product solves (tired, thirsty, a dull look), then the product comes in and it ends on the visible difference, in one continuous take.", for: PEOPLE }),
  opt({
    id: "handoff",
    label: "Hands it over",
    caption: "Passes it to a friend, or someone from your Cast.",
    brief: "Partway through, a second person steps in from the side and the person hands them the product (it changes hands once, clearly; there is only ever one of it); the friend reacts.",
    for: PEOPLE,
  }),
  opt({ id: "joins", label: "Friend joins", caption: "Someone leans in and reacts.", brief: "Partway through, a second person leans into the frame from the side, reacts to the product and adds one line.", for: PEOPLE }),
  // Living photo: what moves.
  opt({ id: "auto", label: "Best fit", caption: "Crackio picks what would really move here.", brief: "Pick the one or two small motions that would really happen in this picture.", for: ["living"] }),
  opt({ id: "steam", label: "Steam & smoke", caption: "Steam off food and drinks, a wisp of smoke.", brief: "Steam rising off something hot (or a wisp of smoke, mist, a breath of cold air), slow and soft.", for: ["living"] }),
  opt({ id: "light", label: "Light & shadow", caption: "Sunlight shifting, leaves moving its shadows.", brief: "The light moves: sunlight shifting slightly, leaf shadows swaying across the surface, a glint traveling over glass.", for: ["living"] }),
  opt({ id: "breeze", label: "Breeze", caption: "Fabric, hair or leaves in the wind.", brief: "A gentle breeze: fabric ripples, hair lifts a little, leaves or curtains sway.", for: ["living"] }),
  opt({ id: "drops", label: "Drops & fizz", caption: "Condensation runs, bubbles rise.", brief: "Water moves: condensation beads slide down the cold product, bubbles rise in a drink, a drip falls, ice settles.", for: ["living"] }),
  opt({ id: "glow", label: "Glow & flicker", caption: "A flame dances, lights twinkle.", brief: "Light sources come alive: a candle flame dances, string lights twinkle, a screen glows, sparkles catch the light.", for: ["living"] }),
  // Hero.
  opt({ id: "sweep", label: "Light sweep", caption: "A highlight glides across it.", brief: "The key light moves slowly off-screen, so a soft highlight slides across the product from one side to the other, catching its edges and label (light on the product, never a visible beam in the air).", for: ["hero"] }),
  opt({ id: "splash", label: "Splash", caption: "Liquid or ingredients burst around it.", brief: "A splash or burst that fits what it is (water crowning around a drink, a cloud of its powder, petals, crumbs), real physics, the product sharp and still in the middle.", for: ["hero"] }),
  opt({ id: "unveil", label: "Reveal", caption: "From shadow or blur into full view.", brief: "It starts in shadow or soft blur and is revealed into full, sharp, perfect light.", for: ["hero"] }),
  opt({ id: "turn", label: "Turn", caption: "It turns slowly to show every side.", brief: "The product turns slowly on a hidden turntable to show its sides, ending with the label facing us.", for: ["hero"] }),
  opt({ id: "elements", label: "Ingredients", caption: "What it's made of floats around it.", brief: "What it's made of or what's in it (real ingredients or materials, only what its label supports) floats and drifts slowly around it.", for: ["hero"] }),
  // Hands-on.
  opt({ id: "unbox", label: "Unbox", caption: "Opened for the first time.", brief: "Hands open it for the first time: the seal, the lid or the pouch, then the first look inside. Counted, satisfying moves.", for: ["demo"] }),
  opt({ id: "pour", label: "Open & pour", caption: "Opened, poured, scooped or sprayed.", brief: "Hands open it and dispense it the real way: pour, scoop, pump, spray or squeeze, showing its real texture and color.", for: ["demo"] }),
  opt({ id: "apply", label: "Put it on", caption: "On skin, a wrist, feet: in use.", brief: "It goes on: applied to the back of a hand or a cheek, fastened on a wrist, slipped on, put on, shown in use.", for: ["demo"] }),
  opt({ id: "detail", label: "Show detail", caption: "Fingers show its texture and features.", brief: "Fingers show off its best details: a texture, a button, a seam, a mechanism, the label, one at a time.", for: ["demo"] }),
  // Campaign.
  opt({ id: "cuts", label: "Fast cuts", caption: "Quick cuts that build.", brief: "Quick hard cuts, each shot one strong move, building in energy to the last shot.", for: ["campaign"] }),
  opt({ id: "flow", label: "Smooth", caption: "Each shot flows into the next.", brief: "Each shot's movement flows into the next one's (matching direction and speed), a smooth premium edit.", for: ["campaign"] }),
  opt({ id: "story", label: "Mini story", caption: "A tiny story across your pictures.", brief: "The pictures become a tiny story with a beginning and an end (a day, a ritual, a before and after).", for: ["campaign"] }),
] as const;

/** Grok's preset voices (xAI's TTS roster), all multilingual. */
export const VOICES = [
  { id: "ara", gender: "female" },
  { id: "eve", gender: "female" },
  { id: "aurora", gender: "female" },
  { id: "carina", gender: "female" },
  { id: "celeste", gender: "female" },
  { id: "iris", gender: "female" },
  { id: "liora", gender: "female" },
  { id: "luna", gender: "female" },
  { id: "ursa", gender: "female" },
  { id: "leo", gender: "male" },
  { id: "rex", gender: "male" },
  { id: "sal", gender: "male" },
  { id: "atlas", gender: "male" },
  { id: "orion", gender: "male" },
  { id: "cosmo", gender: "male" },
  { id: "kepler", gender: "male" },
  { id: "lux", gender: "male" },
] as const;

/** Languages the person can speak (any voice speaks any of them). */
export const LANGUAGES = [
  { id: "en-US", label: "English (US)", cue: "natural, casual American English" },
  { id: "en-GB", label: "English (UK)", cue: "natural, casual British English (a London accent)" },
  { id: "es", label: "Spanish", cue: "natural, casual Spanish from Spain" },
  { id: "es-MX", label: "Spanish (Mexico)", cue: "natural, casual Mexican Spanish" },
  { id: "pt-BR", label: "Portuguese (Brazil)", cue: "natural, casual Brazilian Portuguese" },
  { id: "fr", label: "French", cue: "natural, casual French from Paris" },
  { id: "de", label: "German", cue: "natural, casual German" },
  { id: "it", label: "Italian", cue: "natural, casual Italian" },
  { id: "pl", label: "Polish", cue: "natural, casual Polish" },
  { id: "nl", label: "Dutch", cue: "natural, casual Dutch" },
  { id: "tr", label: "Turkish", cue: "natural, casual Turkish" },
  { id: "hi", label: "Hindi", cue: "natural, casual Hindi" },
  { id: "ja", label: "Japanese", cue: "natural, casual Japanese" },
  { id: "ko", label: "Korean", cue: "natural, casual Korean (Seoul)" },
  { id: "ar", label: "Arabic", cue: "natural, casual Arabic" },
] as const;

export type FilmCameraId = (typeof FILM_CAMERAS)[number]["id"];
export type FilmHookId = (typeof FILM_HOOKS)[number]["id"];
export type FilmMoodId = (typeof FILM_MOODS)[number]["id"];
export type FilmPaceId = (typeof FILM_PACES)[number]["id"];
export type FilmStoryId = (typeof FILM_STORIES)[number]["id"];
export type VoiceId = (typeof VOICES)[number]["id"];
export type LanguageId = (typeof LANGUAGES)[number]["id"];
export type FilmAxis = "style" | "camera" | "hook" | "mood" | "pace" | "story";

/** The steps each style walks through, in order ("words" is what they say). */
export const STYLE_STEPS: Record<FilmStyleId, readonly (FilmAxis | "words")[]> = {
  creator: ["style", "camera", "hook", "mood", "story", "words"],
  lifestyle: ["style", "camera", "hook", "mood", "story"],
  living: ["style", "story", "camera"],
  hero: ["style", "camera", "story", "hook", "pace"],
  demo: ["style", "story", "camera", "hook", "pace"],
  campaign: ["style", "story", "hook", "pace"],
};

/** The picks a style starts from (Best fit where an axis has no "auto"). */
export const STYLE_DEFAULTS: Record<FilmStyleId, { camera: FilmCameraId; hook: FilmHookId; mood: FilmMoodId; pace: FilmPaceId; story: FilmStoryId; seconds: number }> = {
  creator: { camera: "auto", hook: "none", mood: "warm", pace: "natural", story: "one", seconds: 12 },
  lifestyle: { camera: "auto", hook: "none", mood: "warm", pace: "natural", story: "one", seconds: 8 },
  living: { camera: "still", hook: "none", mood: "calm", pace: "calm", story: "auto", seconds: 6 },
  hero: { camera: "push", hook: "none", mood: "calm", pace: "calm", story: "sweep", seconds: 8 },
  demo: { camera: "side", hook: "none", mood: "calm", pace: "natural", story: "unbox", seconds: 8 },
  campaign: { camera: "push", hook: "none", mood: "warm", pace: "punchy", story: "cuts", seconds: 15 },
};

export const filmOptionsFor = <T extends FilmOption>(list: readonly T[], style: FilmStyleId) => list.filter((o) => !o.for || o.for.includes(style));

/** What the person says: Crackio writes it, you write it, or nobody talks. */
export type WordsMode = "auto" | "mine" | "none";

/** A Video take's settings, sent as `params.film`. */
export type FilmSpec = {
  version: 1;
  style: FilmStyleId;
  camera: FilmCameraId;
  hook: FilmHookId;
  mood: FilmMoodId;
  pace: FilmPaceId;
  story: FilmStoryId;
  words: WordsMode;
  /** Their lines, when you wrote them ("mine"). */
  script?: string;
  language: LanguageId;
  /** A preset voice (Grok renders with it at up to 720p); missing lets the model cast one. */
  voice?: VoiceId;
  /** Someone from your Cast who steps in (Hands it over, Friend joins). */
  cast?: { id: string; name: string; kind: "person" | "pet" | "character"; traits?: string };
  /** Seconds wanted (a model may make a little less or more). */
  seconds: number;
  /** End exactly on the first frame, so it loops (models that land on an end frame). */
  loop?: boolean;
  /** How sharp the clip renders: 720p is quicker and lighter on a plan's limits. 1080p when missing. */
  resolution?: "720p" | "1080p";
  /** Burn captions in, timed to the words said (from the clip's transcript). */
  captions?: boolean;
  /** Whether the take's prompt holds the person's own notes. */
  noted: boolean;
  /** Watch every clip against the product and the plan, and re-film once when something's wrong. */
  check?: boolean;
  /** The picture(s) it starts from: each one's URL, and the Product Studio take it came from. */
  pictures: { url: string; from?: string }[];
  /** The product photo (from the take the picture came from), when there is one. */
  productUrl?: string;
  /** Crackio's reading of the product, when the page has it. */
  read?: import("./vocab").ProductRead | null;
};

/** A picture made in Product Studio's Image mode, offered as a video's first frame. */
export type StudioPicture = {
  url: string;
  width: number;
  height: number;
  /** The take it came from (its product photo and reading travel with it). */
  from: string;
  idea: string;
  /** Whether someone is in it: a person, only hands, nobody, or unknown (Best fit). */
  people: "person" | "hands" | "none" | null;
  productUrl?: string;
  /** The sample product most like it, so previews can show one like it. */
  like?: string | null;
  createdAt: number;
};

/** What the director planned for one clip: the idea, the spoken lines and the model's prompt. */
export type FilmPlan = { idea: string; script?: string; prompt: string; seconds: number; picture: number };

/** What the check found on a clip, and whether it was re-filmed because of it. */
export type FilmCheck = { pass: boolean; issues: string[]; retried?: boolean; said?: string };

export const byFilmId = <T extends { id: string }>(list: readonly T[], id: string): T => list.find((o) => o.id === id) ?? list[0];

/** Natural speech runs about 2.5 words a second; a line needs half a second of air at each end. */
export const WORDS_PER_SECOND = 2.4;
export const wordsFor = (seconds: number) => Math.max(4, Math.round((seconds - 1) * WORDS_PER_SECOND));
export const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** The card summary for a take: "Creator · Excited · Snap zoom". */
export function filmSummary(spec: Pick<FilmSpec, "style" | "mood" | "hook" | "story">) {
  const style = byFilmId(FILM_STYLES, spec.style);
  const parts: string[] = [style.label];
  if (PEOPLE.includes(spec.style)) parts.push(byFilmId(FILM_MOODS, spec.mood).label);
  if (spec.hook !== "none") parts.push(byFilmId(FILM_HOOKS, spec.hook).label);
  return parts.join(" · ");
}
