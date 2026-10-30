import "server-only";

/**
 * Motion's playbook: hundreds of concrete moves a senior motion studio reaches for (formats, hooks,
 * structures, camera language, transitions, type treatments, HTML / GSAP / three.js effects, grades,
 * sound design, editing tricks, endings, ways to make generated footage look real) and the habits
 * that make work read as cheap AI. The agent draws from it with the `ideas` tool: a different,
 * fitting hand every time, steered away from what recent projects already used, so no piece is the
 * same template again. Combined (format × hook × look × transitions × sound), it's tens of thousands
 * of distinct pieces.
 */

export type IdeaKind = "format" | "hook" | "structure" | "camera" | "transition" | "type" | "effect" | "look" | "sound" | "edit" | "ending" | "realism" | "avoid";
export type Idea = { id: string; kind: IdeaKind; name: string; tags: string[]; how: string };

type Row = [id: string, name: string, tags: string, how: string];

const KIND_PREFIX: Record<IdeaKind, string> = {
  format: "fmt",
  hook: "hook",
  structure: "arc",
  camera: "cam",
  transition: "tr",
  type: "type",
  effect: "fx",
  look: "look",
  sound: "snd",
  edit: "edit",
  ending: "end",
  realism: "real",
  avoid: "avoid",
};

/* ------------------------------------------------------------------ formats */

const FORMATS: Row[] = [
  ["product-hero-macro", "Macro product film", "ad product luxury beauty drink tech", "Nothing but the product, extremely close: textures, edges, liquid, light crawling over surfaces. 6-9 shots of 0.8-2 s, each a different detail, then one clean wide hero. No people, no copy until the very end. Sound: tactile foley (clicks, pours, fabric) over a minimal pulse."],
  ["ugc-talking", "Creator talking to camera (UGC)", "ugc social ad beauty app product vertical", "One person, phone-camera framing, talking to the lens in their own room with real clutter. Generate the clip with the line in quotes so the video model speaks it (on a plan), and keep the clip's own sound. Jump cuts every 1.5-3 s, punch-ins on the punchline, burned captions 1-3 words at a time. Feels filmed, not produced."],
  ["day-in-life", "Day-in-the-life POV", "ugc social lifestyle product app travel vertical", "First-person or over-the-shoulder moments across one day (wake, commute, work, evening), the product woven into 2-3 of them. Natural light that changes through the day. Quick 0.6-1.2 s cuts on actions, ambient sound from each place, one soft music bed."],
  ["problem-solution", "Problem, then the fix", "ad app saas product explainer", "3 s of the frustrating moment shown, not told (messy desk, broken flow, the spinning loader), a hard cut on a sound hit, then the product making it effortless in 2-3 shots, then the result. One line of copy max per half."],
  ["before-after", "Before / after reveal", "beauty fitness realestate product app edit", "Same framing twice. Reveal the after with a wipe that follows a real motion in the shot (a hand passing, a door closing, a cloth pulled), or a split slider dragged across. Let the after breathe 2 s."],
  ["explainer-visual", "Visual explainer", "explainer education tutorial corporate app", "One idea per beat, each shown by a clear visual (an illustration that builds, a diagram, a photo moving in 2.5D) and named by one short animated line. 2-4 s beats, a soft score from code, a takeaway at the end. Never a list on screen."],
  ["how-to-steps", "Hands-on how-to", "tutorial education food beauty diy pets", "Overhead or close 3/4 angle on hands doing each step in a real home setting. Each step is one continuous action shot; the step change is a match cut on the hands. One short line per step slides in with the action and leaves with it."],
  ["documentary-mini", "Mini documentary", "doc brand story corporate nature", "Observational shots with small natural drift, one quiet line of text per scene like a field note, a room bed and a sparse drone from code. Slow 3-5 s beats; the place tells the story."],
  ["trailer-cut", "Trailer cut", "trailer film game event launch", "Three acts in 30-60 s: world (slow, quiet), conflict (faster cuts, rising riser), crescendo (0.3-0.6 s flash cuts on drum hits), black, title, one last beat shot (the button). Sound design drives it: braams, whooshes, a final silence before the title."],
  ["kinetic-manifesto", "Kinetic manifesto", "brand launch tech saas bold", "A short sentence, revealed a few words per beat, set huge and cut hard on the music. Between phrases, 0.5-1 s footage flashes that literally show the word. Fewer than 25 words total; every word earns its beat."],
  ["one-take", "Single continuous move", "realestate auto product fashion luxury travel", "One unbroken camera move through a space or around a subject (dolly, orbit, crane), built from 2-3 generated clips joined on matching start and end frames so it feels like one take. No cuts, no text until the end. Very premium when the seams are invisible."],
  ["loop-satisfying", "Perfect loop", "social product food abstract vertical", "A 6-10 s piece whose last frame is the first: a pour that refills, an object that rotates 360°, a pattern that tiles. Use end_image = start frame in the clip, or ping-pong render in HTML. No text."],
  ["collage-scrapbook", "Cut-paper collage", "fashion music youth playful brand", "Photos cut out with rough paper edges, tape, scribbles, stop-motion jitter at 12 fps, layers sliding in on the beat. Built in render_html with masked images, CSS transforms and a stepped (12 fps) onFrame clock."],
  ["split-screen-story", "Two lives, side by side", "ad product travel lifestyle", "Two vertical halves telling parallel moments that converge into one full frame at the end. The halves cut on the same beat. Works in 16:9 and 1:1; in 9:16 stack top and bottom."],
  ["countdown-list", "Ranked list (social)", "social education tech vertical", "Number 3, 2, 1 as huge animated numerals between visual examples, each item shown, not described. One short line names each item. Keep each item under 4 s."],
  ["asmr-product", "ASMR product", "product beauty food drink tech", "Extreme close-ups with exaggerated, crisp foley as the star (caps clicking, tapes peeling, ice cracking). Slow, deliberate motion. Music either absent or a faint pad under the sounds."],
  ["recipe-overhead", "Overhead recipe", "food tutorial social", "Top-down camera, ingredients entering frame by hand, each step a 1-2 s clip, speed-ramped stirring, steam and sizzle sounds, a final slow push on the plate. Ingredient names as small labels that arrive with each ingredient."],
  ["unboxing", "Premium unboxing", "product tech beauty fashion", "Hands, a clean surface, slow reveal of layers; each layer a cut. Sound of paper and magnets. End on the product turning in hand, then the logo on the box."],
  ["app-walkthrough", "App in the hand", "app saas tech explainer", "A real-looking phone in a hand (generated photo) with the UI composited onto the screen in render_html, perspective-matched; taps trigger the UI animations; cut between real-life context shots and screen close-ups."],
  ["ui-motion", "Product UI motion", "saas app tech explainer launch", "Floating interface panels in 3D space (CSS 3D or three.js planes), the camera gliding between them, real UI states animating in sequence. Soft depth of field via blur on far layers. No device frames needed."],
  ["data-story", "Data story", "finance corporate education explainer", "One striking number, animated counting up, then the visual that explains it (bars growing from real objects, a map lighting up). One idea per beat, and the chart is the design, not decoration."],
  ["map-journey", "Map journey", "travel doc event explainer", "Stylized map, a line drawing the route with a glowing head, the camera following and dipping into footage at each stop (zoom-through transition into the real place)."],
  ["tour-walkthrough", "Space tour", "realestate travel hospitality", "Smooth gimbal-like moves room to room, each move continuing the previous direction (move left out of one room, enter the next moving left). Natural daylight, real lived-in details."],
  ["lookbook", "Fashion lookbook", "fashion beauty brand", "Same model, same location, looks changing on beat via match cuts (same pose, new outfit), flash frames, film grain. Music with a strong groove; cut on every second beat."],
  ["music-visualizer", "Music-driven visual", "music social abstract", "Picture reacting to the track: cuts on kicks, zoom pulses on snares, color shifts on drops. Read the waveform with look, mark the hits, and time every visual change to them."],
  ["lyric-video", "Lyric video", "music social", "Lyrics appear exactly with the vocals (time them from the waveform or the lyrics file), each line with a treatment that matches its meaning, over footage or abstract motion. 1 line on screen at a time."],
  ["testimonial", "Real testimonial", "ad saas service corporate ugc", "A person speaking naturally, framed off-center, with cutaways to what they describe. Their name once, small. No quote cards; let them speak."],
  ["event-recap", "Event recap", "event recap brand social", "Energy from crowds, details and faces in 0.4-1 s cuts, speed ramps into slow motion on the best moment, the venue name only at the end."],
  ["teaser-mystery", "Mystery teaser", "launch tech product trailer", "Reveal only fragments (an edge, a reflection, a silhouette) in darkness with light sweeps, a ticking pulse building, cut to black and a date or the name. Under 15 s."],
  ["logo-sting", "Logo sting", "brand ident", "3-6 s. One idea from the brand's world (a material, a gesture, a sound) resolving into the mark. One whoosh and one hit. No tagline unless asked."],
  ["title-sequence", "Title sequence", "film trailer event", "Credits woven into the world: names placed on surfaces in the scene (tracked onto walls, reflected in glass), slow camera moves, a theme with a distinct motif."],
  ["comparison-race", "Side-by-side comparison", "tech product app fitness", "Two approaches running simultaneously; a timer or progress bar shows who wins. Keep it honest and visual; one label each."],
  ["myth-buster", "Myth vs fact", "education social health finance", "State the myth with a visual that sells it, then a hard stop (record scratch, freeze, desaturate), then the truth shown with evidence. Narrated."],
  ["character-mascot", "Mascot short", "kids brand playful social", "A consistent character (one hero image as reference for every shot) doing a tiny story with a beginning, a problem and a payoff in 15-20 s. Expressive sound effects."],
  ["stop-motion", "Stop motion", "product food kids playful", "Objects moving in steps at 8-12 fps (render_html with a stepped clock, or generate keyframes and hold each for 2-3 frames). Tactile clicks on every step."],
  ["photo-story", "Photo story with parallax", "doc brand travel memorial nature", "Still photos brought to life: depth map per photo, a 2.5D camera push in three.js, foreground layers sliding over background, slow cross-dissolves. Narration or music carries emotion."],
  ["infographic-explainer", "Animated diagram", "education explainer science tech", "Clean vector diagrams that build up piece by piece in sync with the score, with real footage bookends. Each diagram shows one relationship; arrows draw on, labels are 1-2 words."],
  ["seasonal-mood", "Seasonal mood film", "brand fashion food travel", "Texture-led sequence of a season (frost, steam, low sun, fabric), slow and atmospheric, music with space in it, the product as one of the textures rather than the center."],
  ["challenge-trend", "Trend-format clip", "social ugc vertical playful", "Use a recognizable social structure (POV:, 'things that just make sense', transition challenge) with a twist that's on-brand. Fast, native-looking, captions in the platform style."],
  ["behind-the-scenes", "Behind the scenes", "brand doc product fashion", "Rough, real-looking making-of: hands, tools, mess, work in progress, then the finished thing as the payoff. Handheld energy, ambient workshop sound."],
  ["poster-to-life", "Poster comes alive", "event film launch music", "Start on a designed still (the key art), then elements begin to move one by one (2.5D parallax, particles, light), the camera pushes into it, it becomes a scene."],
  ["object-orbit", "Hero object orbit", "product auto tech luxury", "The object on a turntable-like orbit with a light rig sweeping across, reflections changing; a few speed ramps; one macro detail insert per quarter turn."],
  ["slice-of-craft", "Craft process", "product food luxury fashion brand", "Process from raw material to finished product in 6-10 actions, each close and tactile, building tempo. The final object revealed in a still, quiet frame."],
  ["quote-led", "Quote-led film", "doc corporate brand education", "One real sentence (from the brief or the user's material) revealed a few words at a time over observational pictures that illustrate each phrase, cut to the rhythm of the words."],
  ["meme-edit", "Meme-speed edit", "social youth gaming playful", "Smash cuts, zoom punches, freeze frames with a sound sting, 0.2-0.5 s beats. Use sparingly and only when the brief is playful."],
  ["ytp", "YouTube Poop", "ytp poop remix meme comedy podcast youtube absurd", "Real footage re-cut into absurd comedy: sentences rebuilt from single words (transcript word times), stutters, reverses, pitch and speed gags, zoom punches, inverted or mirrored beats, freeze frames with stings, hard cuts to black. Built as running jokes with setup, twist and escalation; 45-90 s."],
  ["supercut", "Supercut", "supercut remix compilation podcast youtube comedy", "Every time someone says the same word or does the same thing, back to back in rhythm (find them with transcript), accelerating, ending on the one time it's different."],
  ["podcast-highlight", "Podcast highlight", "podcast clip interview talk social vertical", "The best 20-60 s of a long talk: the most surprising line first, then the setup, pauses removed with jump cuts, punch-ins on emphasis, reframed to 9:16 on whoever's talking."],
];

/* ------------------------------------------------------------------ hooks (first 1.5 s) */

const HOOKS: Row[] = [
  ["mid-action", "Start mid-action", "ad social ugc sport food", "Frame one is already moving: the pour has begun, the door is swinging, the hand is reaching. Never open on a still establishing shot or a logo."],
  ["extreme-close", "Unrecognizable close-up", "product beauty food tech", "Open so close the subject is abstract (a texture, a curve), then pull out to reveal what it is within 2 s. Curiosity holds the viewer."],
  ["bold-claim-shown", "Show the claim", "ad app product", "If there's a claim, show it as an event, not as text: the 'waterproof' phone dropped into water in frame one."],
  ["question-hook", "A question first", "explainer education ugc", "One specific question set big in the first second ('Why does your hamster bite at night?') over a visual that makes the viewer want the answer."],
  ["pattern-break", "Pattern break", "social ad playful", "Something visually wrong or unexpected: an object falling up, a color in a grey world, a sudden freeze. Resolve it later in the piece."],
  ["sound-first", "Sound before picture", "trailer doc luxury", "0.5-1 s of a distinct sound over black or a near-black frame (a match strike, breath, a ticking), then the image arrives on the sound's peak."],
  ["fast-montage-open", "Three-shot flash open", "ad event sport fashion", "Three 0.3 s shots of the best moments, a hard stop, then the story begins at a calm pace. It promises what's coming."],
  ["result-first", "Result first", "tutorial beauty food fitness realestate", "Show the finished result first (the dish, the room, the look), then 'here's how' and go back to the start."],
  ["pov-hands", "POV hands", "ugc product app food", "First-person hands entering frame and doing something immediately; it reads as 'this could be me'."],
  ["direct-gaze", "Eye contact", "ugc fashion beauty testimonial", "A person looks straight into the lens and starts speaking or reacts in the first frame. Faces stop the scroll."],
  ["reveal-wipe", "Something wipes the frame", "ad product fashion", "A foreground object (a hand, a cloth, a passing person) wipes across the lens in the first 0.5 s and reveals the subject."],
  ["scale-shock", "Scale shock", "product tech nature travel", "Start tiny then show it's enormous (or the reverse) with a fast pull-back or push-in."],
  ["countdown-number", "Big number", "social education data", "A single huge number fills the frame in the first beat ('3 mistakes', '72 hours'), then cuts to the first example."],
  ["silence-then-hit", "Silence, then the hit", "trailer ad sport", "Half a second of near silence and slow motion, then a hard hit on the first cut. The contrast grabs attention."],
  ["sensory-sound", "Satisfying sound", "asmr product food", "Open on the most satisfying sound of the product (the crack, the click, the fizz), picture tight on its source."],
  ["mismatch", "Unexpected pairing", "brand playful fashion", "Put the subject in a place it doesn't belong for the first shot (perfume in a mechanic's hand, sneakers in a ballroom), then explain."],
  ["light-on", "Lights come on", "product luxury realestate event", "Frame one is dark, a light switches or sweeps on and the subject appears. Pair with a click or a hum."],
  ["text-as-object", "Word as an object", "brand kinetic launch", "The one word of the hook is a physical thing in the scene (on a sign, in neon, written in condensation) rather than an overlay."],
  ["motion-match-open", "Motion from black", "trailer brand", "Movement starts in darkness and continues into the first lit shot (a swing, a turn), so the cut from black feels continuous."],
  ["relatable-moment", "Relatable moment", "ugc app social explainer", "Open on the exact everyday moment the audience knows ('3 a.m., the hamster wheel squeaking'), filmed plainly."],
  ["slow-zoom-tension", "Slow push with a pulse", "doc trailer mystery", "A slow push on an ordinary object while a low pulse builds; the viewer waits for something to happen. Pay it off by 2.5 s."],
  ["contrast-cut", "Before frame, after frame", "beauty realestate fitness", "Two frames back to back in the first second: the before for 0.4 s, the after for 0.6 s, then explain."],
  ["object-enters-lens", "Object into lens", "product drink food sport", "The subject flies or is thrown toward the lens and fills the frame, cut on the moment it would hit."],
  ["crowd-to-one", "From many to one", "event brand fashion", "A busy wide, then a crash zoom or a hard cut into one face or one object in the crowd."],
  ["unboxing-snap", "The snap", "product tech beauty", "A box lid lifting or a magnet snap closing in frame one, with a crisp sound."],
  ["handwritten-start", "Handwriting in progress", "education brand personal", "A pen already writing a word (generate the clip or animate an SVG stroke), the word completes on the first beat."],
  ["reaction-first", "Reaction first", "ugc social testimonial", "Show a genuine reaction (laugh, surprise) before what caused it; then cut to the cause."],
  ["weather-sensory", "Weather and texture", "travel nature seasonal", "Rain on glass, breath in cold air, heat haze on a road: sensory weather as the first image."],
  ["macro-liquid", "Liquid macro", "drink beauty food", "Liquid moving in extreme close-up (a drop landing, a swirl, bubbles rising) as the first frame. Pair with a deep, wet sound."],
  ["glitch-tune-in", "Signal tunes in", "tech gaming music", "The picture arrives through a brief tuning glitch (RGB split, scanlines) that resolves into a clean frame on the beat."],
];

/* ------------------------------------------------------------------ structures */

const STRUCTURES: Row[] = [
  ["hook-build-payoff", "Hook, build, payoff", "ad social", "0-1.5 s hook; 1.5-70% build with 3-6 shots that escalate in energy or detail; last 30% payoff: the product or answer, one line, and a button shot. Never end on the logo alone; end on a beat."],
  ["aida-light", "Attention, interest, desire, act", "ad product", "Attention (motion hook), interest (one surprising detail), desire (the product in a human moment), action (a clean end frame with the name and, if asked, one call to action)."],
  ["three-act-mini", "Three acts in 30 s", "trailer story brand", "Act 1 (0-8 s): world and character. Act 2 (8-22 s): change or tension with accelerating cuts. Act 3 (22-30 s): resolution and title."],
  ["listicle-3", "Three beats", "education social explainer", "Intro line (2 s), three items of equal length each with a distinct visual and a sound cue, outro takeaway. Vary the transition into each item."],
  ["loop-structure", "Circular", "social loop brand", "End visually where you started, so the loop replays seamlessly; the story implies a cycle (morning to morning, empty glass to empty glass)."],
  ["crescendo", "Crescendo", "trailer sport music event", "Shot lengths shrink steadily (3 s, 2 s, 1.2 s, 0.8 s, 0.4 s...) as the music builds; then one long, still shot as the release."],
  ["calm-explainer", "Calm explainer rhythm", "explainer education tutorial pets", "Each idea gets 2-4 s and 1-3 shots with one short line; a soft visual reset (dissolve, light shift, camera height) between chapters instead of chapter cards; the score breathes with the beats."],
  ["question-answer", "Question to answer", "education explainer", "Open with the question, show 2-3 wrong or partial answers quickly, then the real answer with the strongest visual of the piece."],
  ["journey", "Point A to point B", "travel doc brand", "Progress through space or time is the spine: each shot moves forward in the same screen direction, so the edit always travels."],
  ["reveal-ladder", "Reveal ladder", "launch product teaser", "Reveal the subject in steps: shadow, silhouette, detail, half, whole. Each step 1-2 s with a rising tone; the whole only at the end."],
  ["contrast-pairs", "Contrast pairs", "brand fashion ad", "Alternate opposite ideas shot for shot (loud/quiet, fast/slow, night/day), then merge them in the final shot."],
  ["countdown", "Countdown to moment", "launch event sport", "Time pressure drives the cut: a clock, a breath, a heartbeat accelerating toward one moment that lands exactly on a music hit."],
  ["vignettes", "Vignettes with a thread", "brand ad lifestyle", "4-6 short scenes of different people or places, connected by one recurring visual element (the same color, the same gesture, the product)."],
  ["single-subject-day", "One subject, many times", "pets nature doc", "One subject observed across a cycle (a hamster's night, a plant's week), time cues from light and sound, one quiet line per moment."],
  ["demo-loop", "Demo then benefit", "app saas tech", "Show the action (2-4 s), show its effect on a person's life (2-3 s), repeat for up to three features, end on the product name."],
  ["mirror-open-close", "Mirror bookends", "brand story doc", "First and last shots are the same framing with one thing changed. The change is the story."],
  ["escalation-list", "Escalating examples", "social playful ad", "Each example is bigger, faster or more extreme than the last; the final one is absurd or spectacular."],
  ["tutorial-steps", "Numbered steps without numbers", "tutorial how-to food beauty pets", "Steps are separated by sound cues, camera resets and a change of light or place, not by '01/06' cards."],
  ["mood-poem", "Visual poem", "luxury fashion seasonal brand", "No plot: 8-12 images that rhyme in shape, color or motion, cut to a slow piece of music, one or two words at the end."],
  ["myth-truth", "Myth then truth", "education health finance", "Myth (2-4 s, visually believable), a stop beat, truth with proof (4-8 s), a practical takeaway (2-3 s)."],
  ["problem-agitate-solve", "Problem, agitate, solve", "ad app service", "Problem (2 s), why it's worse than you think (2-4 s, quick cuts), solution (4-6 s, calm and clean)."],
  ["feature-orbit", "Orbit through features", "product tech auto", "One continuous camera orbit around the product; at each quarter turn cut to a macro of a feature, then return to the orbit."],
  ["parallel-cut", "Parallel action", "trailer sport story", "Cross-cut two actions that converge (a runner and a finish line, a chef and a diner), each cut shorter than the last, meeting in one frame."],
  ["slow-burn", "Slow burn", "luxury doc nature trailer", "Long, patient shots (4-6 s) with micro-movement, sparse sound, and one sharp change at 70% that recolors everything."],
  ["question-loop-social", "Open loop", "social ugc education", "Promise something in the first 2 s ('the third one changed everything') and only pay it off in the last 3 s."],
];

/* ------------------------------------------------------------------ camera (clip prompts, virtual cameras) */

const CAMERA: Row[] = [
  ["slow-push", "Slow push-in", "any", "Clip prompt: 'slow push in toward [subject], real-time speed'. In HTML: scale 1.0→1.06 over the shot with a slight drift. Builds intimacy."],
  ["pull-reveal", "Pull back reveal", "realestate travel product nature", "'Camera pulls back slowly to reveal [the wider context]'. Start the clip on a detail image and end_image on the wide."],
  ["orbit", "Orbit", "product auto fashion", "'Camera orbits 90° around [subject] at chest height, smooth, the background parallaxing'. Keep the subject centered and the orbit slow."],
  ["handheld-follow", "Handheld follow", "ugc doc sport lifestyle", "'Handheld camera follows [person] from behind at walking pace, natural slight shake'. Instantly less 'AI', more real."],
  ["crane-up", "Crane up", "realestate event travel", "'Camera cranes up from ground level to a high angle over [scene]'. Good as an ending move."],
  ["dolly-lateral", "Lateral dolly", "fashion product food", "'Camera tracks sideways left to right past [objects] in the foreground'. Foreground passing the lens sells depth."],
  ["dolly-zoom", "Dolly zoom", "trailer mystery", "'Dolly zoom on [subject]: background stretches while the subject stays the same size'. One per piece at most."],
  ["whip-pan", "Whip pan", "social energetic travel", "End a clip on a fast pan blur and start the next on one; join them at the blur (add a directional blur in ffmpeg: gblur on the last 4 frames or a 'smear' HTML pass)."],
  ["top-down", "Top-down", "food tutorial product", "'Overhead top-down shot looking straight down at [table], hands entering frame'. Graphic and clean."],
  ["low-angle-hero", "Low angle hero", "product sport fashion auto", "'Low angle looking up at [subject] against the sky'. Makes the subject monumental."],
  ["macro-rack", "Macro rack focus", "beauty product drink nature", "'Extreme macro, focus pulls from [near detail] to [far detail]'. Shallow depth of field, real lens character."],
  ["static-locked", "Locked-off frame", "doc luxury minimal", "A perfectly still camera while the subject moves within the frame. Calm and confident; let action happen inside the frame."],
  ["snorricam", "Body-mounted camera", "sport music youth", "'Camera rigged to the person, face stays fixed in frame while the world moves around them'. Disorienting energy."],
  ["fpv-dive", "FPV drone dive", "travel realestate event sport", "'FPV drone flies fast through [space], diving between [obstacles], ending close on [subject]'. Grok handles fast fly-throughs well; keep 5-6 s."],
  ["push-through", "Push through an opening", "realestate travel story", "'Camera pushes through [a doorway / window / foliage] into [the scene]'. Use as a transition between locations."],
  ["tilt-reveal", "Tilt reveal", "fashion auto realestate", "'Camera tilts up from [shoes / wheels / floor] to reveal [the whole subject]'."],
  ["rack-to-product", "Focus shift to product", "ad product beauty", "Start focused on a person's face, rack to the product in their hand (or the reverse). Ties person and product in one shot."],
  ["parallax-still", "2.5D parallax on a still", "photo-story doc product", "Use depth on the image, then in three.js displace a plane by the depth and move the camera 3-6% sideways or forward. Instantly alive, no generation drift."],
  ["ken-burns-plus", "Ken Burns with intent", "doc photo-story education", "Move toward the point of interest, ease in and out (cubic-bezier(.45,0,.2,1)), add 0.5° rotation and a 1-2% scale breathe. Never a linear zoom to the center."],
  ["speed-ramp-move", "Speed-ramped move", "sport fashion product event", "Fast camera move that slows to near-stop on the key moment, then snaps back. In ffmpeg split the clip and setpts each part (0.4*PTS, 2.5*PTS, 0.5*PTS)."],
  ["handheld-breathing", "Breathing camera", "ugc doc testimonial", "Tiny random-walk drift (seeded noise) of 0.3-0.8% in position and 0.2° rotation added in HTML to static shots; reads as a human operator."],
  ["through-glass", "Through glass", "drink realestate fashion luxury", "Shoot through a glass, a window, a bottle: refraction and reflections layer the frame."],
  ["foreground-frame", "Foreground framing", "travel fashion doc", "Blurry foreground elements (leaves, a doorframe, shoulders) frame the subject; move them slightly for depth."],
  ["reverse-reveal", "Reverse motion", "product playful magic", "Generate an action (spill, scatter) and play it in reverse in ffmpeg (reverse, areverse) so things assemble themselves."],
  ["mirror-match", "Mirror match", "fashion beauty", "A shot in a mirror cut to the direct shot from the same angle, or the reverse. Elegant way to switch looks."],
  ["dutch-tilt", "Slight dutch angle", "music trailer youth", "Tilt the horizon 6-10° for tension or energy; straighten it at the resolution."],
  ["pov-walk", "POV walk-in", "realestate travel ugc", "'First-person view walking into [space], natural head bob, hand pushing the door open'."],
  ["bullet-time", "Frozen moment orbit", "sport product drink", "'Time frozen as the camera orbits around [splash / jump / explosion of particles]'. Spectacular once per piece."],
  ["tracking-vehicle", "Car-to-car tracking", "auto travel sport", "'Camera on a vehicle tracking alongside [subject] at speed, low angle, road blur'."],
  ["overhead-pull", "Overhead pull-up", "nature travel event", "'Top-down shot rising straight up from [subject] until it's small in the landscape'."],
  ["slow-motion-detail", "Slow motion detail", "sport food drink beauty", "'High frame rate slow motion of [droplets / hair / fabric]'. Interleave with real-time shots so slow-mo stays special."],
  ["snap-zoom", "Snap zoom", "social playful ugc", "Digital punch from 100% to 140% in 3 frames on a beat (ffmpeg zoompan or HTML scale with a fast ease), back out on the next beat."],
  ["pedestal", "Pedestal rise", "product luxury", "Camera rises vertically along the product, revealing it bottom to top with a light sweep. 'Camera rises slowly from the base to the top of [product]'."],
  ["arc-shot-person", "Arc around a person", "fashion testimonial music", "'Camera arcs slowly around [person] while they look into the distance'. Emotional beat."],
  ["object-pov", "Object's point of view", "playful product ad", "The camera is the product (inside the fridge, inside the bag, under the glass) looking at the person."],
  ["window-light-static", "Window-light still life", "product luxury food", "Static camera, a soft window light slowly shifting across the scene (animate a gradient mask in HTML or prompt 'light slowly moving across')."],
  ["drone-establish", "Drone establishing", "travel realestate event", "'Aerial drone shot slowly descending toward [place] at blue hour'. Use once to place the story."],
  ["crash-zoom-face", "Crash zoom to face", "meme social trailer", "Fast zoom into a face on a sound hit, held for 0.3 s. Comic or dramatic."],
  ["rotation-roll", "Barrel roll", "music tech gaming", "Camera rotates 90-180° around its axis during a move; cut out mid-rotation into a shot rotating the same way."],
  ["gimbal-float", "Floating gimbal", "fashion luxury realestate", "'Smooth floating gimbal shot gliding forward', the classic premium movement. Keep subjects simple."],
];

/* ------------------------------------------------------------------ transitions */

const TRANSITIONS: Row[] = [
  ["hard-cut-action", "Cut on action", "any", "Cut in the middle of a movement (a hand lifting, a turn) and continue the movement in the next shot. The most invisible, most professional transition. Default to this."],
  ["match-shape", "Shape match cut", "brand trailer fashion", "End on a round object, open on another round object in the same place (moon to plate, eye to lens). Generate the second shot with a start frame composed to match."],
  ["match-motion", "Motion match", "sport fashion travel", "A movement exiting frame right is continued by a different subject entering from the left at the same speed."],
  ["match-color", "Color match", "fashion brand mood", "Cut from a red dress to a red door: the dominant color carries the eye across locations."],
  ["j-cut", "J-cut", "doc explainer story", "The next shot's sound starts 0.3-0.8 s before its picture. In ffmpeg offset the audio with adelay or build the sound bed separately."],
  ["l-cut", "L-cut", "doc testimonial story", "The current shot's sound continues 0.5-1 s under the next picture. Smooths narrative edits."],
  ["whip-transition", "Whip pan transition", "social travel energetic", "Last 4 frames of A and first 4 of B get a horizontal motion blur (in HTML: CSS filter blur with translateX smear; in ffmpeg: xfade=transition=hblur or smoothleft at 0.25 s) plus a whoosh."],
  ["zoom-through", "Zoom-through", "travel tech event", "Scale A up to 300% into a dark or bright area while B scales from 60% to 100% behind it; add radial blur and a whoosh. xfade=transition=zoomin at 0.4 s is a cheap version."],
  ["mask-object", "Object wipe", "ad fashion product", "A foreground object (a person walking past, a hand, a door) covers the lens; the next shot starts behind the same kind of object. Generate both clips with that action."],
  ["light-leak", "Light leak", "fashion wedding travel warm", "A 0.3-0.5 s burst of overexposed orange-pink light (radial gradients with mix-blend-mode: screen in HTML) bridging two shots. Use once or twice, never on every cut."],
  ["flash-frame", "Flash frame", "music trailer fashion", "1-2 white or near-white frames between shots on a hit. Brutal and exciting; keep for peaks."],
  ["dip-black", "Dip to black", "doc trailer luxury", "A 0.3-0.6 s fade through black between chapters (xfade=transition=fadeblack). Use for time jumps, not for every cut."],
  ["cross-dissolve", "Soft dissolve", "calm doc nature explainer", "0.6-1.2 s dissolve (xfade=transition=fade or dissolve) for gentle time or place changes in calm pieces only."],
  ["glitch-cut", "Glitch transition", "tech gaming music", "3-5 frames of RGB split, slice displacement and noise (HTML canvas or CSS clip-path slices). Pair with a digital stutter sound."],
  ["morph-match", "Morph between frames", "fashion product magic", "Generate a clip with start_image = last frame of A and end_image = first frame of B; the model morphs one into the other."],
  ["push-slide", "Push slide", "app saas explainer", "B pushes A out of frame in the direction of motion (xfade=transition=slideleft/smoothleft at 0.35 s). Works for UI and lists; keep the direction consistent."],
  ["iris-reveal", "Shape reveal", "playful kids brand", "B appears inside a growing shape (circle, logo silhouette) over A: xfade=transition=circleopen, or a CSS clip-path animation."],
  ["split-reveal", "Split reveal", "launch fashion bold", "A splits into 2-4 panels that slide apart to reveal B behind. Staggered by 0.05 s each."],
  ["blur-refocus", "Defocus, refocus", "beauty luxury doc", "A goes out of focus (gblur sigma rising), B arrives blurred and sharpens. Dreamy, quiet."],
  ["smash-cut", "Smash cut", "playful social trailer", "A loud, busy shot cut directly to a quiet one (or the reverse) with no transition. The contrast is the joke or the drama."],
  ["sound-bridge", "Sound bridge", "doc story trailer", "A sound from shot B (a train, a laugh) rises under shot A and motivates the cut."],
  ["ink-bleed", "Ink or paint bleed", "art fashion music", "B revealed through an organic, growing mask (an ink-blot SVG turbulence filter animated in HTML, or a luma-matte video)."],
  ["page-turn", "Paper or page turn", "collage playful education", "A paper-like fold or tear reveals B (CSS 3D rotateY on a half with a shadow gradient). Pair with paper sound."],
  ["swipe-ui", "Phone-native swipe", "ugc social app", "B slides up like a vertical feed swipe in 0.25 s with a slight bounce. Feels native to Reels and TikTok."],
  ["rack-transition", "Focus-pull transition", "luxury beauty", "End A with a rack to a blurry foreground, start B on a blurry foreground that racks to sharp."],
  ["speed-ramp-cut", "Speed ramp cut", "sport fashion auto", "Accelerate the last 0.3 s of A (setpts=0.3*PTS), cut, decelerate the first 0.3 s of B. Add a whoosh."],
  ["luma-fade", "Luma fade", "nature doc music", "Brightest parts of B appear first (xfade=transition=fadegrays or a luma mask in HTML). Organic and cinematic."],
  ["zoom-punch", "Punch-in on beat", "social ugc music", "No transition, but every new shot starts at 106% and settles to 100% in 0.25 s. Keeps energy without effects."],
  ["camera-shake-hit", "Impact shake", "trailer sport game", "On the cut, 4-6 frames of decaying shake (translate ±12px, seeded) plus a low boom."],
  ["pixel-sort", "Pixel stretch", "music tech fashion", "Stretch a row of pixels across the frame (CSS scaleY on a 1px slice of A) into B. Graphic, modern."],
  ["film-burn", "Film burn", "retro wedding travel", "A warm burn texture (radial gradients plus noise, blend screen) eats A into B. Use only in retro looks."],
  ["vertical-wipe-object", "Vertical object wipe", "product fashion food", "A tall object (pole, bottle, person) passes the lens left to right and B is revealed behind it, in one direction only."],
  ["pull-focus-black", "Fade to texture", "luxury minimal", "A fades into a dark texture (fabric, stone) that then lights up as B's background."],
  ["typography-mask", "Image through letters", "launch brand kinetic", "The next shot appears inside huge letters of one word, then the letters scale up past the frame and B fills it."],
  ["reflection-cut", "Reflection transition", "auto fashion realestate", "Tilt from the subject to a reflection (puddle, glass, car body) and cut to the next scene seen in that reflection."],
  ["darkness-hide", "Hide the cut in darkness", "trailer doc nature", "End A as the camera passes a dark object or turns into shadow; begin B coming out of darkness. Invisible join for 'one take' pieces."],
  ["object-hand-off", "Hand-off", "product ad lifestyle", "An object is handed or thrown out of frame in A and caught in B by a different person in a new place."],
  ["rotate-transition", "Spin transition", "music social energetic", "A rotates out 90° with motion blur, B rotates in from -90° (CSS rotate with a blur filter) plus a whoosh. Once per piece."],
  ["grid-to-full", "Grid to full frame", "fashion product recap", "Several shots tile into a grid, then one tile scales to full frame and becomes the next shot."],
  ["breath-pause", "Breath before the cut", "doc luxury emotional", "Hold A 0.5 s longer than feels necessary with the sound dropping out, then cut. Gives weight to the next shot."],
  ["xfade-catalog", "ffmpeg xfade catalog", "any", "xfade transitions: fade, fadeblack, fadewhite, dissolve, pixelize, radial, circleopen, circleclose, hblur, smoothleft/right/up/down, slideleft/right, wipeleft/right, zoomin, distance, fadegrays, squeezeh, diagtl, hlslice, vuslice, coverleft, revealright. Pick one family per piece."],
];

/* ------------------------------------------------------------------ type treatments (few words, big ideas) */

const TYPE: Row[] = [
  ["one-word-beats", "One word per beat", "kinetic launch social", "One word at a time, huge (20-30% of frame height), cut on the beat, never two lines. Display face with character (Anton, Archivo Black, Bricolage Grotesque, Fraunces Black)."],
  ["subtle-caption", "Native captions", "ugc social explainer vertical", "Captions 1-3 words at a time, bold sans, white with a soft shadow, lower-middle of the frame (above the platform UI zone, about 62-70% height), synced to speech in the clip. No boxes, no bars."],
  ["end-name-only", "Name only at the end", "luxury product brand", "No copy during the film; the brand name alone, centered, tracking slightly open, appears on the final held shot. Nothing else on that frame."],
  ["word-in-scene", "Type in the scene", "brand fashion trailer", "Place the text on a real surface of the footage (a wall, the sky, a table) with perspective, tracked to the camera move, partly occluded by foreground."],
  ["mask-reveal-type", "Masked rise", "any", "Each line rises from behind an invisible baseline (overflow hidden, translateY 100%→0, 0.7 s, cubic-bezier(.16,1,.3,1)), letters staggered 18-30 ms."],
  ["split-letters", "Split-letter assemble", "launch kinetic", "GSAP SplitText: letters fly in from 5-10° rotations and blur(8px) to sharp, staggered from the center out."],
  ["typewriter", "Typed text", "tech explainer story", "Characters appear one by one with a blinking caret and soft key clicks. Use for one line, never paragraphs."],
  ["outline-fill", "Outline then fill", "sport bold launch", "Huge outlined letters (-webkit-text-stroke) that fill with color from bottom to top on the hit."],
  ["serif-elegance", "Quiet serif", "luxury beauty fashion", "A refined serif (Cormorant Garamond, Fraunces 300, Instrument Serif) small and generous, fading in with letter-spacing closing from 0.3em to 0.08em over 1.5 s."],
  ["handwritten", "Handwritten line", "personal food kids education", "A handwritten word drawn on with an SVG stroke animation (stroke-dashoffset), ink texture, one per piece."],
  ["counter-number", "Rolling number", "data finance social", "A number counting up with an ease-out (tabular figures), the digits rolling vertically, ending on a tiny overshoot."],
  ["giant-crop", "Oversized type behind subject", "fashion sport bold", "A huge word behind the subject (use the cutout trick: duplicate the footage layer with a person mask in front of the type), so the subject stands in front of the word."],
  ["scramble", "Decode scramble", "tech gaming launch", "Characters scramble through random glyphs (seeded) and settle left to right. GSAP ScrambleTextPlugin or a seeded onFrame loop."],
  ["stacked-lockup", "Stacked lockup", "brand launch end", "Two to three short lines stacked tight with mixed weights; animate each line in from alternating sides 80 ms apart."],
  ["lowercase-intimate", "Lowercase whisper", "ugc personal music", "Small lowercase sans, generous tracking, low contrast, placed off-center: intimate, unpolished, human."],
  ["kinetic-path", "Text on a path", "music playful", "A phrase travelling along a curved SVG path (textPath with startOffset animated), following an object's motion."],
  ["blur-in-word", "Blur to sharp", "luxury beauty calm", "Word arrives from blur(20px) and 1.08 scale to sharp at 1.0 over 0.9 s; leaves the same way reversed."],
  ["color-swap-word", "Color-swapped keyword", "ad social", "One keyword in a line in the accent color and a different weight; the rest neutral. Only one accent word per piece."],
  ["no-text", "No text at all", "luxury mood music nature asmr", "Let picture and sound do everything. Often the most premium choice. If the user asked for none, deliver none, not even a logo, unless asked."],
  ["label-callout", "Minimal callout", "product tech explainer", "A thin line draws from a product detail to a 1-3 word label, both appear in 0.4 s and leave after 1.5 s. At most two per piece."],
  ["date-stamp", "Camcorder stamp", "retro ugc travel", "A small orange VHS-style date stamp in the corner for a home-video vibe; the only text on screen."],
  ["subtitle-cinema", "Cinema subtitles", "doc trailer story", "Clean centered subtitles in the lower 12% for speech only, white, no background, 1 line, 42 characters max."],
  ["big-number-type", "Huge numeral", "list social data", "A single numeral filling 70% of the frame height, footage visible through it (background-clip:text with a video, or a mask), then the item."],
  ["fade-sentence", "Sentence that thins out", "manifesto brand", "Show a full sentence for 0.8 s, then every word except the keyword fades out, leaving the one idea."],
];

/* ------------------------------------------------------------------ effects (render_html, GSAP, three.js, ffmpeg) */

const EFFECTS: Row[] = [
  ["depth-parallax", "Depth parallax (three.js)", "photo-story product travel doc", "depth tool → image-depth.png. three.js: PlaneGeometry(1,aspect,256,256) with a vertex shader displacing z by depth * 0.15; camera on the photo's axis moving 4% sideways and 6% forward over the shot; fov 35. Keep displacement small to avoid stretching at edges; scale the plane 1.08 to hide borders."],
  ["volumetric-light", "Light sweep", "product luxury beauty", "A soft diagonal gradient band (linear-gradient with transparent edges, mix-blend-mode: screen, blur 30px) sweeping across the subject in 1.2 s with an ease. Once per shot at most."],
  ["film-grain", "Film grain", "any cinematic real", "Animated grain over everything: a canvas of seeded noise redrawn each frame at 1/3 resolution, opacity 0.06-0.1, mix-blend-mode: overlay. Unifies generated shots and kills the plastic look."],
  ["halation", "Halation glow", "fashion night film", "Duplicate the footage, blur 18px, keep only highlights (filter: brightness(0.6) contrast(3)), tint red-orange, blend screen at 0.25. Real film character in highlights."],
  ["chromatic-edge", "Chromatic aberration", "tech music fashion", "Offset red and blue copies by 1-3px toward the frame edges only (radial mask). Subtle; peaks only at transitions."],
  ["vignette-breathe", "Breathing vignette", "doc luxury calm", "Radial vignette at 18-25% darkening, its size breathing ±3% over 6 s. Focuses the eye."],
  ["particles-dust", "Floating dust", "luxury product nature calm", "300-800 small soft particles drifting slowly in 3D (three.js Points with size attenuation), lit by the scene's key light direction. Add depth of field by blurring far ones."],
  ["bokeh-layer", "Foreground bokeh", "beauty fashion night", "Large soft circles (radial gradients) in the foreground drifting slower than the subject, low opacity; sells a long lens."],
  ["shader-transition", "Displacement transition (three.js)", "tech fashion launch", "Two textures on a plane; fragment shader mixes them with a noise-driven threshold (smoothstep(p - 0.1, p + 0.1, noise(uv * 3.0))) while displacing uv along the noise gradient. 0.6 s."],
  ["ripple", "Liquid ripple", "drink beauty water", "Fragment shader ripple from a point: uv += normalize(uv - c) * sin(dist * 40.0 - t * 12.0) * 0.004 * fade. On a drop impact."],
  ["text-3d-extrude", "Extruded 3D type", "launch gaming sport", "three.js TextGeometry needs font JSON; instead stack 20 copies of a CSS text layer in translateZ (transform-style: preserve-3d) with darkening colors for an extruded look, rotate the group slowly."],
  ["glass-card-3d", "Floating glass panels", "app saas tech", "CSS 3D: panels with backdrop-filter blur(20px), 1px light border, perspective 1600px; camera (a wrapper) moves through them with GSAP. Real UI content inside."],
  ["infinite-zoom", "Infinite zoom", "travel story playful", "A chain of images where each is centered inside the previous one; scale the stack exponentially (scale = 2^(t*speed)) so the camera zooms forever into nested scenes. Generate each next image as a 'zoomed-out version' with the previous as reference."],
  ["cutout-pop", "Subject pop-out", "fashion sport ugc", "Subject cut out of the frame (ask generate_image for the same shot on a flat green or white background, or mask), placed over the original with a drop shadow, scaling 1.0→1.08 while the background darkens."],
  ["split-color", "Duotone shift", "music fashion bold", "Map footage to two brand colors (filter: grayscale(1) then two gradient-map layers via mix-blend-mode multiply/screen) for a graphic section, back to full color on the drop."],
  ["scanline-crt", "CRT screen", "retro gaming music", "Repeating-linear-gradient scanlines, slight barrel distortion (SVG feDisplacementMap), RGB offset, flicker of 2% brightness."],
  ["paper-texture", "Paper texture", "collage education kids", "Overlay a generated paper texture at 30% with multiply; slightly rotate elements (±1.5°) and step their motion at 12 fps for a handmade feel."],
  ["motion-blur-trail", "Motion blur trails", "sport auto energetic", "Render fast-moving elements with 6-8 ghost copies at decreasing opacity along their path, or use ffmpeg tmix=frames=4 on a section."],
  ["light-trails", "Light trails", "night city auto music", "Long exposure trails: additive-blended canvas lines that persist with a fade (draw each frame from t-0.5 s to t with alpha falling off)."],
  ["mirror-kaleido", "Kaleidoscope", "music fashion abstract", "Canvas or shader mirroring of footage into 6 segments, rotating slowly. Short bursts only."],
  ["fluid-gradient", "Living gradient background", "brand app calm", "A mesh gradient of 3-4 brand-safe hues animated with slow sinusoidal control points (canvas radial gradients) behind type or UI. Never as a rainbow."],
  ["reflection-floor", "Reflective floor", "product luxury tech", "Mirror the product below itself (scaleY(-1)), fade with a gradient mask, blur 2px, opacity 0.3."],
  ["depth-of-field", "Rack focus in HTML", "product fashion", "Two or three layers; animate filter: blur() on far and near layers inversely to shift focus between them."],
  ["photo-to-sketch", "Sketch to photo", "explainer architecture product", "A line drawing (generate_image as a pencil sketch from the photo as reference) wiped into the photo with a soft brush mask."],
  ["draw-on-svg", "Line draw-on", "explainer data map", "SVG paths with stroke-dasharray = length and dashoffset animated to 0; an arrowhead follows the tip. Lines in the brand accent, 3-4 px."],
  ["map-route", "Route on a map", "travel event", "An SVG map (simple shapes, not a screenshot) with a route drawing on and the camera (a wrapper transform) following its head; city dots pulse as it passes."],
  ["counting-bars", "Bars from objects", "data finance education", "Bar chart where each bar is a stack of real objects (generated image strips) rising with a spring ease; the value counts beside it."],
  ["phone-composite", "Screen composite", "app ugc tech", "Place UI (rendered HTML or an image) onto a phone in a generated photo with CSS matrix3d using the four screen corners; add glass reflection on top."],
  ["glow-outline", "Glow outline", "gaming music night", "Neon outline around a cutout subject (drop-shadow filters in the brand color, flickering 3% for 0.2 s on hits)."],
  ["mosaic-tiles", "Tile mosaic", "recap fashion event", "Grid of clips playing simultaneously, tiles flipping (rotateX) to new clips in a wave pattern; then one tile zooms to full."],
  ["time-remap-freeze", "Freeze frame accent", "sport meme story", "Freeze on the peak frame (ffmpeg tpad or a still from frameAt) for 0.4-0.8 s with a desaturation and a camera shutter sound, then resume."],
  ["stutter-step", "Stutter step", "music fashion", "Repeat 3-4 frames twice on a beat (ffmpeg loop on a short trim) for a rhythmic stutter."],
  ["lens-dirt", "Lens dirt and flares", "auto night sport", "On bright moments, a lens-dirt texture revealed by highlights (blend screen through a highlight mask) and a soft anamorphic streak."],
  ["silhouette-reveal", "Silhouette backlight", "fashion fitness mystery", "Prompt the subject backlit against a bright window or sky; animate exposure from silhouette (brightness 0.3) to detail (1.0) as the reveal."],
  ["gsap-timeline", "GSAP master timeline", "any html", "Build everything in one gsap.timeline({ paused: true }) with labels per beat, then window.onFrame = (t) => tl.seek(t). Overlap tweens with '<0.15' and use eases like expo.out, power3.inOut, back.out(1.4)."],
  ["three-camera-path", "Camera path through a scene (three.js)", "tech realestate abstract", "A CatmullRomCurve3 through 4-6 points; camera.position = curve.getPointAt(ease(t / T)); camera.lookAt(curve.getPointAt(min(1, u + 0.02))). Smooth, cinematic moves through generated environment planes."],
  ["image-planes-3d", "Images floating in 3D", "recap fashion portfolio travel", "Project images as planes at varied depths; a slow dolly passes through them with fog fading the far ones (scene.fog = new THREE.Fog(bg, 4, 14))."],
  ["bloom-pass", "Bloom (three.js)", "night tech music", "EffectComposer + UnrealBloomPass (strength 0.6-1.0, radius 0.4, threshold 0.75) on a three.js scene; light sources and neon glow realistically."],
  ["noise-displace", "Organic warp", "music fashion abstract", "SVG feTurbulence + feDisplacementMap over an image, baseFrequency animated slowly; scale 0→30 at a transition, back to 0."],
  ["clip-path-panels", "Diagonal panels", "launch sport bold", "Footage split by angled clip-path polygons sliding in from alternating directions, each panel a different shot, settling into one."],
  ["sticker-pop", "Stickers and doodles", "ugc youth playful", "Hand-drawn SVG doodles (arrows, circles, stars) popping on with back.out ease and a little rotation, pointing at things in the footage. Max three per piece."],
  ["progress-thread", "Thin progress thread", "tutorial explainer social", "A 2-3 px line along the bottom edge growing with the piece's progress, in the accent color. The only persistent UI element allowed, and only for tutorials."],
  ["picture-in-picture", "Picture in picture", "ugc reaction tutorial", "A rounded rectangle inset of a detail or a reaction (22-28% width) in a corner, with a soft shadow; enters with a spring."],
  ["zoom-blur-burst", "Zoom blur burst", "sport launch energetic", "Radial blur centered on the subject (stack 8 scaled copies 1.0-1.12 at decreasing opacity) for 0.2 s on the hit."],
  ["rgb-split-hit", "RGB split on hit", "music tech", "Separate R, G, B layers (mix-blend-mode: screen with colored multiplies) offset 6-14px for 3 frames on a drum hit."],
  ["ink-type-reveal", "Ink reveal", "art luxury", "A grayscale ink-spread video or animated SVG turbulence used as a mask (mask-image) to reveal the next image or word."],
  ["ken-burns-depth-layers", "Layered stills", "doc story education", "Separate a still into 2-3 layers (subject cutout, mid, background) and move them at different speeds; background slightly blurred."],
  ["sky-replace-motion", "Living sky", "realestate travel", "Add slow cloud movement to a still: mask the sky (depth: farthest 15%) and translate a cloud texture behind it at 1-2% per second."],
  ["water-caustics", "Caustics", "drink beauty pool summer", "Animated caustic light pattern (two scrolling noise textures multiplied, blend screen at 0.15) on surfaces near water or glass."],
  ["confetti-burst", "Confetti burst", "event playful launch", "Seeded physics: 200 rectangles with initial velocities, gravity and rotation computed from t (pure function of t, no state), on the reveal beat."],
];

/* ------------------------------------------------------------------ looks / grades */

const LOOKS: Row[] = [
  ["neutral-clean", "Neutral clean", "any explainer product app pets", "True whites, neutral greys, natural skin, gentle contrast. ffmpeg: eq=contrast=1.04:saturation=1.02, and if the cast tool flags yellow: colortemperature=temperature=7000:mix=0.6 or colorbalance=bs=0.05:bm=0.04:bh=0.03:rs=-0.03:rm=-0.02:rh=-0.02."],
  ["daylight-documentary", "Daylight documentary", "doc pets nature education", "Soft overcast daylight, 5600K, low saturation (0.92), lifted blacks (curves=all='0/0.03 1/1'), no warm wash. Feels observed, honest."],
  ["cool-premium", "Cool premium", "tech luxury auto", "Blue-grey shadows, clean highlights: colorbalance=bs=0.08:bm=0.02:hs=0, eq=saturation=0.9:contrast=1.08. Metal and glass look expensive."],
  ["teal-skin", "Skin and cool shadows", "fashion trailer", "Shadows lean teal, skin stays natural: colorbalance=rs=-0.06:bs=0.06:rh=0.02. Subtle, not the 2012 orange-teal cliché."],
  ["high-key-white", "High key", "beauty product app minimal", "Bright, airy, soft shadows, near-white backgrounds, saturation 0.95. curves=all='0/0.05 0.5/0.58 1/1'."],
  ["low-key-noir", "Low key", "luxury mystery trailer", "Deep blacks, one hard key light, high contrast (eq=contrast=1.2:brightness=-0.03), color only in the subject."],
  ["film-stock-portra", "Film stock (Portra-like)", "fashion travel wedding", "Soft contrast, creamy highlights, slight green-cyan shadows, fine grain. curves with lifted toe, colorbalance=gs=0.03:bs=0.02, grain overlay 0.07."],
  ["film-stock-tungsten", "Tungsten night film", "night city music", "Cool cyan-blue night with warm practical lights, halation on highlights, grain 0.1. Keep skin true."],
  ["bleach-bypass", "Bleach bypass", "sport war trailer gritty", "Desaturated (0.6), high contrast, silvery highlights: eq=saturation=0.6:contrast=1.25. Gritty, intense."],
  ["pastel-soft", "Pastel soft", "kids beauty playful", "Lifted blacks, low contrast, pastel hues, pink-blue palette; saturation 0.85 with hue-specific boosts in design elements, not a wash."],
  ["monochrome-accent", "Monochrome with one color", "fashion brand launch", "Black and white footage with only the product color kept (hue mask in HTML, or generate both versions and composite)."],
  ["natural-green", "Natural green", "nature pets food health", "Greens rich but not neon, neutral highlights, earthy midtones. Avoid the yellow-green AI tint: check that whites stay white."],
  ["vhs-home", "Home video", "retro ugc nostalgia", "Slight blur, chroma bleed, 4:3 crop, date stamp, noise, softened highlights; only when the brief wants nostalgia."],
  ["golden-hour-earned", "Golden hour (earned)", "travel fashion lifestyle", "Warm only when the scene is really at sunset: the light is low and directional, shadows long, the sky shows it. Keep whites in shade neutral-cool for contrast; never wash the whole frame yellow."],
  ["blue-hour", "Blue hour", "realestate city travel luxury", "Deep blue ambient, warm windows and street lights, balanced exposure. Very premium for spaces and cities."],
  ["clinical-bright", "Clinical bright", "health tech science", "Cool whites, sharp detail, minimal shadows, clean surfaces; saturation 0.95, contrast 1.05."],
  ["moody-desaturated", "Moody desaturated", "doc story music", "Saturation 0.7, cool shadows, warm faint highlights, crushed toe slightly. Emotional, serious."],
  ["vivid-pop", "Vivid pop", "playful kids food social", "Bold saturated primaries in the subjects and set design (not a global saturation push), clean whites, high clarity."],
  ["sepia-avoid", "Avoid sepia default", "any", "If a frame looks beige-yellow overall without a reason (no sunset, no tungsten lamp in shot), it's the AI default: neutralize it. Check the color line from look."],
  ["monochrome-silver", "Silver black and white", "fashion doc luxury", "format=gray, then curves for a deep black and bright silver highlight; add grain. Timeless."],
  ["neon-night", "Neon night", "music gaming city", "Magenta and cyan practicals in the scene, deep shadows, wet reflective surfaces; keep skin readable with a soft fill."],
  ["matte-editorial", "Matte editorial", "fashion beauty brand", "Lifted blacks (0.06), slightly lowered whites (0.96), muted saturation (0.88), neutral balance. Magazine feel."],
  ["sunlit-fresh", "Sunlit fresh", "drink food summer travel", "Bright midday sun, crisp shadows, cyan sky, saturated but natural color, white balance neutral. The opposite of the yellow haze."],
  ["candlelight-real", "Candlelight (real)", "luxury food romance", "Warm only from visible candles or lamps; the rest falls into deep neutral shadow. The warm must have a source in frame."],
  ["one-look-rule", "One look per piece", "any", "Pick one grade and apply it to every shot in the final pass (one ffmpeg filter chain), so generated clips from different prompts match."],
];

/* ------------------------------------------------------------------ sound */

const SOUND: Row[] = [
  ["hit-list-first", "Hit list first", "any", "Before writing sound, list the picture's moments with their seconds (cuts, reveals, type entrances, the logo, the end). Every sound is scheduled to one of them; nothing floats."],
  ["minimal-pulse", "Minimal pulse", "tech product app launch", "kit.beat(96-110, 0, END, { kick: 'x.......x.......', hat: '..x...x...x...x.' }) on a bus at gain 0.7, a sustained kit.bass on the root, one kit.pad chord change at the midpoint. Modern, leaves room for picture."],
  ["calm-plucks", "Calm plucks", "explainer education pets nature lifestyle", "A soft kit.pad (two chords, 4-6 s each, gain 0.04) and kit.pluck notes from a pentatonic scale (A C D E G) every 0.5-1 s, panned left and right. Gentle, never busy."],
  ["luxury-design", "Luxury sound design, no music", "luxury beauty fashion product", "No beat at all: a kit.room bed, a slow kit.whoosh on each camera move, a kit.shimmer when light catches the product, one kit.impact (gain 0.5) on the name. Silence around each sound."],
  ["ui-ticks", "Interface ticks", "app saas tech explainer", "kit.tick on every tap, toggle and card landing (freq 1800-2800, gain 0.08-0.12), a soft kit.whoosh (from 800, to 3000, 0.3 s) on panel slides, a pad underneath at gain 0.03."],
  ["riser-reveal", "Riser into the reveal", "launch trailer product", "kit.riser(REVEAL - 2.5, 2.5) so it stops dead on the reveal, then kit.impact(REVEAL) and 0.3 s of near silence after. The cut and the hit share the same frame."],
  ["four-on-floor", "Four on the floor", "fashion event sport fitness", "kit.beat(120-124, 0, END, { kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', open: '......x.......x.' }), duck the pad bus on every kick (kit.duck(pad, hits.kick, { depth: 0.5 })), cut the picture every 2 or 4 beats."],
  ["half-time", "Half-time weight", "trailer sport moody", "kit.beat(70-80, 0, END, { kick: 'x.........x.....', snare: '........x.......' }) with a deep kit.bass and a dark kit.pad (minor chord, cutoff 900). Heavy and slow; cuts land on the snare."],
  ["arp-lift", "Arpeggio lift", "tech launch explainer", "kit.pluck an arpeggio of the chord on 8th or 16th notes, raising the pad's filter (open) over the build; drop everything but the bass for one bar before the end."],
  ["whoosh-moves", "Whooshes on moves", "any", "kit.whoosh under whip pans, slides and fast type entrances only: duration = the move's length, pan = the direction of travel (-0.6 to 0.6). Not on every cut."],
  ["tactile-foley", "Tactile foley from code", "product asmr food", "Short filtered noise bursts for clicks and taps (kit.tick at low freq 400-900 for wood, 3000 for glass), a soft lowpassed noise swell for fabric, kit.room for space. Close, crisp, in sync with each frame."],
  ["silence-hit", "Silence, then the hit", "trailer launch luxury", "Drop every bus to zero 0.4 s before the key moment (bus.gain.setValueAtTime), then the hit. The silence makes it land."],
  ["keep-clip-sound", "Keep the clip's sound", "ugc doc product", "On a plan, generated clips carry real sound (pours, room, a line spoken on camera): keep it, clean it (highpass=f=80,lowpass=f=14000), and lay a quiet score under it."],
  ["ending", "A real ending", "any", "The score ends on purpose: a final chord left to ring (long release), a last impact and its reverb tail, or an afade over the last 1.5 s. Never cut off mid-note."],
  ["key-for-mood", "Key and tempo for the mood", "any", "Major and slow (C, F, G major, 70-90 bpm) for warm and calm; minor (A, D, E minor) for serious or moody; 110-128 bpm for energy. Write the chord list before the code."],
  ["signature-sound", "Sonic signature", "brand logo launch", "One recognizable sound (a two-note pluck, a shimmer, a soft impact) at the open and again on the logo, so the piece has an identity."],
  ["mix-levels", "Levels that ship", "any", "Music bus around 0.6-0.8, effects 6-12 dB under the music, then loudnorm=I=-14:TP=-1.5:LRA=9 on the final mix in ffmpeg. Check with look on the final file."],
  ["texture-bed", "Texture bed", "nature travel calm doc", "kit.room plus a very quiet high kit.tone drone (type sine, gain 0.01-0.02) and a slow pad, so the picture never falls into dead silence."],
  ["gag-stings", "Gag stings from code", "ytp poop meme comedy remix", "Comedy sounds in render_audio: a boing (a sine sweeping up with vibrato), a record scratch (noise with a fast pitch bend), a deep boom (a low sine drop, saturated), a ding. Short, sharp, peaking just under the voice, never clipping."],
];

/* ------------------------------------------------------------------ editing */

const EDIT: Row[] = [
  ["vary-shot-length", "Vary shot lengths", "any", "Never use equal shot lengths. Mix 0.6, 1.4, 0.9, 2.5, 0.5... Uniform 7 s shots make a slideshow."],
  ["cut-on-beat", "Cut on the beat", "music ad social", "Cuts land on beats (or exactly on the 'and'); type and effects land on the same grid. Off-beat cuts feel amateur."],
  ["trim-the-drift", "Trim generated clips hard", "any generated", "Use only the best 1-3 s of a generated clip, usually from the first half before drift sets in. Never keep a full 6-8 s clip because it exists."],
  ["action-in-every-shot", "Something moves in every shot", "any", "Every shot needs subject motion, camera motion, or light motion. A still frame with text on it is a slide, not a shot."],
  ["full-bleed", "Full-bleed footage", "any", "Footage fills the frame. Don't box clips into panels next to text columns unless the format is a deliberate split screen."],
  ["contrast-tempo", "Tempo contrast", "trailer ad", "After fast sections, one slow shot. After quiet, one loud. Rhythm is contrast."],
  ["coverage-variety", "Wide, medium, close", "any", "Alternate scales: a wide to orient, a medium for action, a close for detail and emotion. Two shots of the same size in a row need a reason."],
  ["screen-direction", "Screen direction", "travel sport journey", "Keep movement direction consistent across cuts (everything travels left to right) unless you want conflict."],
  ["insert-shots", "Insert shots", "product food tutorial", "Cut to 0.6-1 s macro inserts of the detail being discussed. They add production value and hide joins."],
  ["reaction-cutaway", "Cutaways", "doc ugc testimonial", "When a talking shot runs long or glitches, cut away to what they're talking about, keeping the clip's sound."],
  ["speed-ramp", "Speed ramps", "sport fashion product", "Split a clip at the key moment; slow the moment (setpts=2.5*PTS with minterpolate=fps=30:mi_mode=mci for smoothness if needed), speed the approach (0.5*PTS)."],
  ["front-load", "Front-load the best", "social ad", "The strongest image goes in the first 3 seconds. Social viewers decide fast."],
  ["end-on-motion", "End on motion", "any", "The last shot still moves (a slow push, a turn, light) while the name appears; a static final frame feels like the video froze."],
  ["chapter-without-cards", "Chapters without cards", "explainer tutorial education", "Separate chapters with a change of place, light, or camera height and a sound cue, not with numbered title cards."],
  ["remove-dead-air", "Remove dead frames", "any", "Cut the first frames of clips where the model 'wakes up' (the first 0.1-0.3 s of a generated clip is often static), and anything after the action is complete."],
  ["consistent-subject", "Keep the subject consistent", "any generated", "Generate one hero image of the person, animal, product or place first and use it as the reference or start frame for every other shot. Check every frame for drift (face, fur pattern, logo, color)."],
  ["safe-zones", "Platform safe zones", "social vertical", "For 9:16, keep text and key action out of the top 12% and bottom 20% (platform UI) and the right 12% (buttons)."],
  ["pace-for-reading", "Paced for reading", "explainer doc", "A line needs about 0.3 s per word plus 0.8 s to land; cut the next beat only after it's read. Fewer words buy faster cuts."],
  ["reuse-with-change", "Reuse with a change", "ad social brand", "Reusing a shot is fine if it changes (reversed, punched in, regraded, slowed); identical repeats look cheap."],
  ["open-wide-close-tight", "Start wide, end tight", "story doc", "The camera gets closer as the story gets more personal."],
  ["no-template-chrome", "No template chrome", "any", "No header bars, footer bars, page numbers, chapter counters, hairline rules, corner tags or progress counters ('01 / 06'). It's a film, not a slide deck or a website."],
  ["build-in-sections", "Build in sections", "any long", "Long pieces: render or edit in 10-20 s sections with consistent settings and join with concat or xfade; check each section before joining."],
  ["proxy-check", "Look at the cut early", "any", "Assemble a rough cut early (straight cuts, no polish) and look at it; fix structure before polishing details."],
  ["regenerate-once", "Regenerate with a reason", "any generated", "If a clip is broken (melting hands, morphing face, impossible physics), regenerate once with a more specific prompt, or replace the shot. Don't keep it and hope."],
  ["ugc-jumpcuts", "Jump cuts for talk", "ugc social", "Remove pauses in talking shots with jump cuts, alternating a 100% and a 110% punch-in so the jump looks deliberate."],
  ["sentence-mix", "Sentence mixing", "ytp poop remix meme comedy", "Find each word you need with transcript, cut it with 0.03-0.08 s of air (re-encoded, so the cut is exact), join the words into a new sentence, and hide the jumps with quick zooms or a cut to the listener."],
  ["stutter-loop", "Stutter on a syllable", "ytp poop remix meme music", "Repeat a 0.1-0.25 s slice 3-6 times (the same trim concatenated), each repeat punched in a little more, then let the word finish."],
  ["reverse-pingpong", "Reverse and back", "ytp poop remix meme", "A gesture forward, reversed (reverse,areverse on a short trim), then forward again: a 'nope' loop that lands on the beat."],
  ["pitch-gag", "Pitch and speed gag", "ytp poop remix meme comedy", "One line pitched up (asetrate at 1.5x the clip's sample rate, usually 44100*1.5, then aresample=48000,atempo=0.667 keeps its speed) or slowed into a deep voice, for one beat only, with a punch-in to match."],
  ["chaos-beat", "A beat of chaos", "ytp poop remix meme glitch", "For 0.3-1 s: negate, hue=h=t*360, hflip, rgbashift or a crash zoom on a sound sting, then straight back to normal. The contrast is the joke; constant chaos isn't."],
];

/* ------------------------------------------------------------------ endings */

const ENDINGS: Row[] = [
  ["button-shot", "Button shot", "ad story", "After the main ending, one extra 1-1.5 s beat with a smile, a twist or a callback. It's what people remember."],
  ["product-held", "Product in hand", "product ad", "End on the product held by a real hand in a real place, the name appearing small beside it. No separate logo card needed."],
  ["logo-from-scene", "Logo from the scene", "brand", "The logo forms from something in the last shot (light, liquid, steam, a shadow), not a cut to a white card."],
  ["quiet-end", "Quiet end", "luxury doc", "The music resolves, one held shot with natural sound, the name fades in, fade out. Calm confidence."],
  ["callback", "Callback to the open", "story social", "The last shot answers or mirrors the first one."],
  ["cta-minimal", "One call to action", "ad app", "If a CTA is needed: one short line ('Try it free') and the name, nothing else; set in the same type as the rest of the piece."],
  ["loop-end", "Loop end", "social loop", "Ending frame flows into the opening frame so the platform loop feels continuous."],
  ["takeaway-line", "Takeaway line", "explainer education tutorial", "End with one short line of advice over a calm, beautiful shot of the subject."],
  ["freeze-name", "Freeze and name", "sport event fashion", "Freeze the peak frame, slight desaturation, the name appears; sound hit then silence."],
  ["hard-black", "Hard cut to black", "trailer mystery", "Cut to black on a hit, hold 0.5 s, title, hold, out. Tension."],
  ["pull-back-end", "Pull back to wide", "travel doc nature", "The final shot pulls back or cranes up to show the whole world, the subject small in it."],
  ["walk-away", "Walk away", "fashion story", "The subject leaves the frame, the camera lingers on the empty place for a beat."],
  ["no-endcard", "No end card", "ugc social native", "For native social pieces, no end card at all: end on the last line and a natural reaction."],
];

/* ------------------------------------------------------------------ realism (prompts that don't look AI) */

const REALISM: Row[] = [
  ["camera-spec", "Name a real camera", "any image clip", "Write prompts as a photographer's notes: 'shot on a full-frame mirrorless camera, 35mm lens at f/2.8, 1/250 s, ISO 800'. Real optics give real depth and grain."],
  ["neutral-wb", "Ask for neutral white balance", "any image", "Say 'neutral white balance, true whites, accurate colors' and name a daylight source ('overcast daylight from a north window'). This prevents the yellow AI wash."],
  ["real-light-sources", "Motivated light", "any image clip", "Every light has a source: window light from the left, an overhead fluorescent tube, a phone screen glow, low sun through blinds. Never 'cinematic lighting' or 'dramatic glow'."],
  ["imperfection", "Real imperfection", "any image", "Add lived-in detail: a scuffed table edge, cable clutter, fingerprints on glass, slightly wrinkled fabric, dust in the light, uneven paint. Perfection is the AI tell."],
  ["candid-people", "Candid people", "people ugc lifestyle", "People mid-action and unposed: looking away, half-laughing, mid-sentence, natural skin texture with pores and small blemishes, real body proportions, everyday clothes."],
  ["avoid-ai-words", "Banned prompt words", "any image clip", "Never write: cinematic, epic, stunning, masterpiece, ultra-detailed, 8k, hyperrealistic, award-winning, ethereal, magical glow, golden light (unless it's a real sunset). They produce the generic AI look."],
  ["composition-specific", "Specific composition", "any image", "Say where things are: 'subject in the left third, horizon low, foreground leaves blurred across the bottom right'. Avoid default centered symmetric hero shots for every image."],
  ["animal-realism", "Real animals", "pets nature", "Name the exact breed and coloring, the real habitat details (paper bedding, a hide, a chewed wooden house), real behavior at its real speed; macro lens. Keep the same animal from one reference image."],
  ["product-realism", "Real product photography", "product ad", "Name the surface (honed marble, raw oak, brushed steel), the light setup (one softbox from the left, white bounce card right), real reflections; keep labels from the reference, never invent text."],
  ["clip-real-speed", "Real-time motion", "any clip", "Say 'real-time speed, natural motion' unless you truly want slow motion. Generated clips default to dreamy slow motion, which reads as AI."],
  ["clip-one-action", "One action per clip", "any clip", "Describe one clear action and one camera move per clip. Lists of actions produce morphing and confusion."],
  ["clip-handheld", "A human camera", "ugc doc lifestyle", "'Handheld phone footage, slight natural shake, autofocus breathing' makes generated clips feel filmed by a person."],
  ["season-time", "Time and place", "any image", "Name the hour, season and weather ('10 a.m. in late October, overcast, soft shadows'). Specific time beats generic beauty."],
  ["material-truth", "Material truth", "product food", "Describe how materials behave: condensation beading on cold glass, steam curling, oil sheen, fabric weight. Real physics reads real."],
  ["skin-truth", "Skin truth", "beauty fashion people", "'natural skin texture, visible pores, no retouching, slight shine on the nose' rather than flawless airbrushed skin."],
  ["environment-real", "Real places", "any image", "Real, specific places rather than staged sets: 'a small rented apartment kitchen with a window over the sink', 'a pet shop aisle under fluorescent lights'."],
  ["color-palette-prompt", "Palette in the prompt", "any image", "State the palette: 'muted sage, off-white and charcoal' so every shot matches, instead of letting each image choose warm defaults."],
  ["reference-consistency", "Reference chaining", "any generated", "Pass the hero image as a reference for every later image and use generated images as start frames for clips; describe what must stay identical ('same hamster: golden-white Syrian with a white chest patch')."],
  ["text-in-images", "No text in generated images", "any image", "Generated text is garbled. Keep words out of images and clips; add type in render_html."],
  ["hands-check", "Check hands and faces", "people ugc", "Hands and faces are where generated media breaks. Frame them simply (hands holding one object, face in 3/4 view), and inspect them in frames before using a clip."],
  ["phone-photo-look", "Phone photo look", "ugc social lifestyle", "'Shot on a phone, slightly overexposed window, natural noise in shadows, vertical framing' for UGC that blends with real feeds."],
  ["avoid-symmetry", "Break symmetry", "any image", "Asymmetric framing, slight tilt, partial occlusion. Perfect symmetry everywhere is a generated look."],
  ["grain-unifies", "Grain unifies", "any edit", "A shared grain and grade over all shots hides differences between generated clips and makes them feel shot on one camera."],
  ["depth-cues", "Depth cues", "any image", "Foreground, subject, background in every frame: something close and soft, the subject sharp, a readable background."],
  ["reshoot-not-fix", "Regenerate, don't overpaint", "any generated", "If an image is off (wrong breed, extra limb, odd hands), regenerate with a precise fix in the prompt rather than covering it with text or effects."],
];

/* ------------------------------------------------------------------ avoid (what makes work read as cheap AI) */

const AVOID: Row[] = [
  ["slide-deck", "Slide-deck layout", "any", "A text column beside a boxed video, repeated chapter after chapter. Viewers read it as a PowerPoint. Use full-bleed footage with almost no text."],
  ["text-wall", "Text walls", "any", "More than about 7 words on screen at once, or text in every shot. Pictures carry the information; text names one idea at a time."],
  ["ui-chrome", "Fake UI chrome", "any", "Header bars with the brand name, footer bars, arrows, hairline dividers, '01 / 06' counters, tags like 'THE EVERYDAY ESSENTIALS'. They make a film look like a template website."],
  ["dash-separators", "Dashes and separators", "any", "Em dashes, slashes, pipes and middots as decoration in on-screen text ('Bergamot · Rose · Oud', 'COLD — SMOOTH'). Use line breaks and timing instead."],
  ["yellow-wash", "The yellow AI wash", "any", "Everything beige, amber or yellow with no light source that explains it. Check the color line on every image; neutralize; ask for neutral white balance."],
  ["plastic-perfect", "Plastic perfection", "any", "Spotless surfaces, airbrushed skin, everything centered and glowing. Add imperfection, real light and asymmetry."],
  ["silent-film", "Silence", "any", "No sound at all, or a mix so quiet it's inaudible (under -30 LUFS). Score every piece with render_audio unless the user asks for silence."],
  ["equal-shots", "Equal shot lengths", "any", "Every shot 5-8 s long, cut at regular intervals. Vary the rhythm."],
  ["full-generated-clips", "Uncut generated clips", "any generated", "Using every generated clip at its full length, including the slow start and the drifting end."],
  ["same-transition", "One transition everywhere", "any", "Crossfading every cut. Default to cuts on action; save transitions for chapter changes and peaks."],
  ["logo-card-white", "Generic end card", "any", "A cut to a flat beige or white card with the logo, a tagline and a divider. End inside the world of the film instead."],
  ["dreamy-slowmo", "Dreamy slow motion everywhere", "any generated", "Every clip in floaty slow motion. Ask for real-time speed; use slow motion only for one or two moments."],
  ["morph-artifacts", "Morphing and melting", "any generated", "Faces changing between frames, extra fingers, objects merging, liquids behaving like jelly. Trim, regenerate or cut away."],
  ["center-everything", "Everything centered", "any", "Every shot and every title centered in the frame. Use thirds, edges and negative space."],
  ["stock-cliches", "Stock clichés", "any", "Handshakes, lightbulbs, glowing brains, globes, people pointing at blank screens. Find the specific, real image of this subject."],
  ["over-effects", "Effects for their own sake", "any", "Glitches, light leaks and shakes on every cut. One signature effect used with intent beats ten random ones."],
  ["generic-fonts", "Default fonts", "any", "Arial, Times, Montserrat-for-everything, or the same serif in every piece. Choose type for this brand and this mood."],
  ["unreadable-type", "Unreadable type", "any", "Small text over busy footage, light text on light areas, text shorter than 1.2 s. If it's on screen, it must be readable at phone size."],
  ["self-praise", "Self-praise", "any", "Calling a piece 'cinematic', 'stunning' or 'premium' in the message to the user. Describe what you made plainly; let them judge."],
  ["mismatched-clips", "Mismatched shots", "any generated", "Shots with different color temperatures, grain and contrast cut together. Apply one grade in the final pass."],
  ["frozen-holds", "Frozen holds", "any", "Long holds on a still image or a frozen frame without motion or sound change, reading as a broken player."],
  ["boxed-captions", "Heavy caption boxes", "any", "Thick black boxes or pill backgrounds behind every caption. Use clean type with a soft shadow."],
  ["chapter-numbers", "Numbered chapters", "explainer tutorial", "'Step 01', 'Chapter 2 of 6' cards. Change place, light or camera instead, and let each line stand alone."],
  ["too-long", "Longer than the idea", "any", "Padding to reach a length. If the user gave a length, fill it with more shots and better pacing, not with longer holds."],
  ["generate-everything", "Generating everything", "any", "Every beat a generated picture or clip, even the ones that are type, shapes or UI. Make those in code; generate only what needs real imagery."],
  ["random-palette", "Accidental palette", "any", "Each shot with its own colors because each prompt chose its own. Decide the palette in the plan and put it in every prompt."],
];

const SOURCES: Record<IdeaKind, Row[]> = {
  format: FORMATS,
  hook: HOOKS,
  structure: STRUCTURES,
  camera: CAMERA,
  transition: TRANSITIONS,
  type: TYPE,
  effect: EFFECTS,
  look: LOOKS,
  sound: SOUND,
  edit: EDIT,
  ending: ENDINGS,
  realism: REALISM,
  avoid: AVOID,
};

export const PLAYBOOK: Idea[] = (Object.keys(SOURCES) as IdeaKind[]).flatMap((kind) =>
  SOURCES[kind].map(([id, name, tags, how]) => ({ id: `${KIND_PREFIX[kind]}-${id}`, kind, name, tags: tags.split(/\s+/).filter(Boolean), how })),
);

export const IDEA_KINDS = Object.keys(SOURCES) as IdeaKind[];

const byId = new Map(PLAYBOOK.map((i) => [i.id, i]));
export const ideaById = (id: string) => byId.get(id);

/** A small seeded generator, so a draw is varied per project but repeatable within it. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD = /[a-z0-9]+/g;

/**
 * A hand of ideas for what's being made: matched on tags and words, shuffled per project, and
 * steered away from moves recent projects already used (`avoid`). Universal rules ("any") stay in
 * play but never crowd out the specific ones.
 */
export function drawIdeas({ about, kinds, count, seed, avoid = [] }: { about: string; kinds: IdeaKind[]; count: number; seed: string; avoid?: string[] }): Idea[] {
  const words = new Set((about.toLowerCase().match(WORD) ?? []).flatMap((w) => [w, w.replace(/s$/, "")]));
  const recent = new Set(avoid);
  const random = rng(seed);
  const pool = PLAYBOOK.filter((i) => kinds.includes(i.kind));
  const scored = pool.map((i) => {
    const hits = i.tags.filter((t) => words.has(t)).length + (i.name.toLowerCase().match(WORD) ?? []).filter((w) => words.has(w)).length * 0.5;
    const universal = i.tags.includes("any") ? 0.6 : 0;
    const penalty = recent.has(i.id) ? 2.5 : 0;
    return { i, score: hits * 1.4 + universal - penalty + random() * 1.6 };
  });
  scored.sort((a, b) => b.score - a.score);
  // Spread the hand across the asked-for kinds.
  const per = Math.max(1, Math.ceil(count / kinds.length));
  const out: Idea[] = [];
  for (const kind of kinds) out.push(...scored.filter((s) => s.i.kind === kind).slice(0, per).map((s) => s.i));
  return out.slice(0, Math.max(count, kinds.length));
}

export const formatIdea = (i: Idea) => `[${i.id}] ${i.name}: ${i.how}`;

/* ------------------------------------------------------------------ the plan and its lint */

export type PlanShot = { seconds: number; what: string; camera?: string; source?: string; transition?: string; text?: string };
export type MotionPlan = {
  concept: string;
  format?: string;
  audience?: string;
  seconds: number;
  look: string;
  palette?: string;
  type?: string;
  voice?: string;
  music?: string;
  sfx?: string;
  captions?: boolean;
  shots: PlanShot[];
  moves?: string[];
  at?: number;
};

const words = (s?: string) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * A senior's first read of a plan: the mistakes that make work look cheap, caught before a single
 * credit is spent. Warnings, not rules; the agent decides.
 */
export function lintPlan(plan: MotionPlan, recent: { format?: string; moves?: string[]; look?: string }[]): string[] {
  const notes: string[] = [];
  const shots = plan.shots ?? [];
  const total = shots.reduce((s, x) => s + (Number(x.seconds) || 0), 0);
  const seconds = Number(plan.seconds) || total;
  if (shots.length && Math.abs(total - seconds) > Math.max(1, seconds * 0.08)) notes.push(`The shots add up to ${total.toFixed(1)} s but the piece is ${seconds} s. Make them agree.`);
  const avg = shots.length ? total / shots.length : seconds;
  const calm = /explain|guide|tutorial|educat|doc|calm|slow|luxur|ambient|poem/i.test(`${plan.format} ${plan.concept}`);
  if (shots.length && avg > (calm ? 4.5 : 3)) notes.push(`Average shot length is ${avg.toFixed(1)} s: that plays like a slideshow. Break shots into more, shorter moments (${calm ? "2-4 s for calm pieces" : "0.6-2.5 s for ads and social"}), with inserts and cutaways.`);
  const lens = shots.map((s) => Math.round((Number(s.seconds) || 0) * 10) / 10);
  if (lens.length >= 4 && new Set(lens).size <= Math.ceil(lens.length / 3)) notes.push("Shot lengths are nearly all the same. Vary the rhythm.");
  const onScreen = shots.reduce((s, x) => s + words(x.text), 0);
  // Explainers carry their information in short lines now; ads and moods stay sparse.
  const explainer = /explain|guide|tutorial|how to|educat|care|tips/i.test(`${plan.format} ${plan.concept}`);
  const budget = Math.max(8, Math.round(seconds * (explainer ? 0.9 : calm ? 0.45 : 0.6)));
  if (onScreen > budget) notes.push(`${onScreen} words of on-screen text planned; aim for ${budget} or fewer. Let the pictures carry it.`);
  const texty = shots.filter((s) => words(s.text) > 0).length;
  if (shots.length >= 4 && texty / shots.length > 0.5) notes.push(`Text on ${texty} of ${shots.length} shots. Most shots should have none.`);
  const long = shots.filter((s) => words(s.text) > 7);
  if (long.length) notes.push(`Shot${long.length > 1 ? "s" : ""} ${long.map((s) => shots.indexOf(s) + 1).join(", ")} carr${long.length > 1 ? "y" : "ies"} more than 7 words at once. One short line at most.`);
  if (/[—–|·•]|\s\/\s|\b0\d\s*\/\s*0\d\b/.test(shots.map((s) => s.text ?? "").join(" "))) notes.push("On-screen text uses dashes, pipes, middots or '01 / 06' counters. Drop the separators and the numbering.");
  if (!plan.music && !plan.sfx) notes.push("No sound planned. Plan the score and the effects you'll write with render_audio (or the clip sound you'll keep); silence reads as broken.");
  if (/warm|golden|amber|sepia|honey|beige|cream/i.test(`${plan.look} ${plan.palette}`)) notes.push("The look leans warm. Keep it only if the light in the scenes motivates it, keep whites neutral, and check the color line on every image: the yellow wash is the first thing people notice as AI.");
  const trs = shots.map((s) => (s.transition ?? "").toLowerCase().trim()).filter(Boolean);
  if (trs.length >= 4) {
    const top = [...trs.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / trs.length > 0.7 && !/cut/.test(top[0])) notes.push(`"${top[0]}" on almost every cut. Default to cuts on action; keep transitions for chapter changes and peaks.`);
  }
  const noMotion = shots.filter((s) => !s.camera && !/move|walk|pour|turn|run|push|pull|drift|orbit|pan|track|rise|fall|spin|swing|flow|steam|reach|slide|open|close|grab|eat|chew|burrow/i.test(s.what));
  if (noMotion.length > shots.length / 2 && shots.length >= 3) notes.push("Most shots don't say what moves. Give every shot a subject action, a camera move or a light change.");
  if (!plan.moves?.length) notes.push("No signature moves picked. Draw from ideas and name 2-4 (by id) that make this piece distinct.");
  const generated = shots.filter((x) => x.source === "image" || x.source === "clip").length;
  if (shots.length >= 4 && generated === shots.length) notes.push("Every shot is a generated picture or clip. Make the type, graphic, UI and abstract beats in render_html; generate only what needs real imagery.");
  const recentFormats = recent.map((r) => (r.format ?? "").toLowerCase()).filter(Boolean);
  if (plan.format && recentFormats.includes(plan.format.toLowerCase())) notes.push(`"${plan.format}" was used by a recent project. Fine if the brief demands it; otherwise pick a different angle.`);
  const used = new Map<string, number>();
  for (const r of recent) for (const m of r.moves ?? []) used.set(m, (used.get(m) ?? 0) + 1);
  const repeats = (plan.moves ?? []).filter((m) => (used.get(m) ?? 0) >= 2);
  if (repeats.length) notes.push(`Moves used in several recent projects: ${repeats.join(", ")}. Swap at least one for something fresh.`);
  return notes;
}
