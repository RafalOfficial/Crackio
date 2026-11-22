import "server-only";
import { nanoid } from "nanoid";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { launch } from "@/lib/motion/render";
import type { CameraRig } from "@/lib/director/types";
import { fail } from "./errors";
import { shownFrom, type Shown } from "./pictures";

/**
 * The Director for agents. Its camera view is drawn in the browser (three.js), so the server keeps a hidden browser
 * page of the Director itself per place an agent opens: the same page a person uses, driven through its own store
 * (components/director/agent-hook). A camera command changes the scene and reads back what the camera sees; Shoot is
 * the page's own Shoot, so the shot is made from exactly the view the agent was shown.
 *
 * Needs Chrome or Edge on the computer Crackio runs on. A place lives while it's used: one left alone for 15 minutes is
 * closed, and opened again from its picture in a few seconds. Nothing in a person's own Director is touched: the hidden
 * page has its own storage.
 */
type Hook = {
  scene: () => { camera: CameraRig; aspect: string; notes: string; place: { image?: { view?: unknown } } };
  act: (name: string, ...args: unknown[]) => unknown;
  view: (long?: number) => Promise<string>;
  setShot: (model?: string, size?: string) => void;
  shotModel: () => string;
  shootError: () => string | null;
  shoot: () => Promise<void>;
};
// What runs inside the page reaches the hook this way (the functions below are sent to the page as text).
declare const window: { __crackioAgent: Hook };

export type Picture = { url: string; width: number; height: number };
type Place = { id: string; context: BrowserContext; page: Page; picture: Picture; openedAt: number; usedAt: number; turn: Promise<unknown> };

const IDLE_MS = 15 * 60_000;
const g = globalThis as unknown as { __crackioAgentDirector?: { browser: Browser | null; starting: Promise<Browser> | null; places: Map<string, Place>; sweeper: ReturnType<typeof setInterval> | null } };
const state = (g.__crackioAgentDirector ??= { browser: null, starting: null, places: new Map(), sweeper: null });

const origin = () => `http://127.0.0.1:${process.env.PORT || 3000}`;

async function browser(): Promise<Browser> {
  if (state.browser?.isConnected()) return state.browser;
  state.starting ??= launch()
    .then((b) => {
      state.browser = b;
      b.on("disconnected", () => {
        state.browser = null;
        state.places.clear();
      });
      return b;
    })
    .finally(() => (state.starting = null));
  try {
    return await state.starting;
  } catch {
    throw fail("browser_missing");
  }
}

function sweep() {
  for (const p of state.places.values()) if (Date.now() - p.usedAt > IDLE_MS) void closePlace(p.id);
  if (!state.places.size && state.sweeper) {
    clearInterval(state.sweeper);
    state.sweeper = null;
    void state.browser?.close().catch(() => undefined);
    state.browser = null;
  }
}

export async function closePlace(id: string) {
  const p = state.places.get(id);
  if (!p) return false;
  state.places.delete(id);
  await p.context.close().catch(() => undefined);
  return true;
}

export const openPlaces = () => [...state.places.values()].map((p) => ({ place: p.id, picture: p.picture.url, opened_min_ago: Math.round((Date.now() - p.openedAt) / 60_000) }));

function place(id: string | undefined): Place {
  const p = id ? state.places.get(id) : undefined;
  if (!p) {
    throw fail("invalid_input", { field: "place", what: id ? `There's no open place "${id.slice(0, 20)}" (places close after 15 minutes without use).` : "Say which place: its id from open.", allowed: [...state.places.keys()], do: "Open the place again from its picture: it takes a few seconds." });
  }
  p.usedAt = Date.now();
  return p;
}

/** One thing at a time per place: a camera move and a view are one step, never interleaved with another call's. */
function inTurn<T>(p: Place, work: () => Promise<T>): Promise<T> {
  const next = p.turn.then(work, work);
  p.turn = next.catch(() => undefined);
  return next;
}

export type Pose = { turn: number; height: number; distance: number; lens: number; roll: number };
const poseOf = (c: CameraRig): Pose => ({ turn: Math.round(c.azimuth * 10) / 10, height: Math.round(c.elevation * 10) / 10, distance: Math.round(c.distance * 100) / 100, lens: Math.round(c.focal), roll: Math.round(c.roll * 10) / 10 });

async function look(p: Place, long: number): Promise<{ shown: Shown; pose: Pose }> {
  // A frame or two for the stage to draw the new camera before it's read.
  await p.page.waitForTimeout(350);
  const dataUrl = await p.page.evaluate((n) => window.__crackioAgent.view(n), long);
  const camera = await p.page.evaluate(() => window.__crackioAgent.scene().camera);
  const jpeg = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return { shown: await shownFrom(jpeg, `director|${p.id}|${JSON.stringify(camera)}|${long}`), pose: poseOf(camera) };
}

/** Opens a place from a picture: the Director builds its 3D set, and the camera stands where the photo was taken. */
export async function openPlace(picture: Picture, long = 768): Promise<{ place: string; shown: Shown; pose: Pose; seconds: number }> {
  const started = Date.now();
  const b = await browser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    // In development the page would join Next's reload channel: its messages are swallowed, so this page never makes
    // the dev server rebuild or reload anyone's tab.
    if (process.env.NODE_ENV !== "production") {
      await page.routeWebSocket(/.*/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage(() => {});
        server.onMessage((m) => ws.send(m));
      });
    }
    await page.goto(`${origin()}/director?agent=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.__crackioAgent), null, { timeout: 120_000 });
    await page.evaluate((pic) => window.__crackioAgent.act("setPlace", pic), picture);
    // The set is built when the Director knows how the photo was taken (its view).
    await page.waitForFunction(() => Boolean(window.__crackioAgent.scene().place.image?.view), null, { timeout: 300_000 });
    await page.waitForTimeout(900);
  } catch (err) {
    await context.close().catch(() => undefined);
    throw fail("job_failed", { what: "The Director couldn't build a place from that picture.", why: (err as Error).message.split("\n")[0].slice(0, 200), do: "Try again, or another picture. If it keeps failing, tell the user." });
  }
  const p: Place = { id: nanoid(8), context, page, picture, openedAt: Date.now(), usedAt: Date.now(), turn: Promise.resolve() };
  state.places.set(p.id, p);
  state.sweeper ??= setInterval(sweep, 60_000);
  const seen = await inTurn(p, () => look(p, long));
  return { place: p.id, ...seen, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export type Move = { reset?: boolean; angle?: string; shot?: string; turn?: number; height?: number; distance?: number; lens?: number; roll?: number; turn_by?: number; closer?: number };

/** Moves the camera, then says what it sees: every camera command answers with the view and the pose. */
export function moveCamera(id: string, move: Move, long = 768) {
  const p = place(id);
  return inTurn(p, async () => {
    await p.page.evaluate((m) => {
      const a = window.__crackioAgent;
      if (m.reset) a.act("toPhotoView");
      if (m.angle) a.act("applyAngle", m.angle);
      if (m.shot) a.act("applyShotSize", m.shot);
      const c = a.scene().camera;
      const patch: Record<string, number> = {};
      if (m.turn !== undefined) patch.azimuth = m.turn;
      if (m.turn_by !== undefined) patch.azimuth = c.azimuth + m.turn_by;
      if (m.height !== undefined) patch.elevation = m.height;
      if (m.distance !== undefined) patch.distance = m.distance;
      // closer: 2 halves the distance, 0.5 doubles it.
      if (m.closer !== undefined && m.closer > 0) patch.distance = c.distance / m.closer;
      if (m.lens !== undefined) patch.focal = m.lens;
      if (m.roll !== undefined) patch.roll = m.roll;
      if (Object.keys(patch).length) a.act("setCamera", patch);
    }, move);
    return look(p, long);
  });
}

export function viewOf(id: string, long = 768) {
  const p = place(id);
  return inTurn(p, () => look(p, long));
}

/** The model the page would shoot with now ("auto": none of the Director's shot models can run), after `model` and `size` were set. */
export function shotModel(id: string, model?: string, size?: string): Promise<{ model: string; aspect: string }> {
  const p = place(id);
  return inTurn(p, async () => {
    await p.page.evaluate(({ m, s }) => window.__crackioAgent.setShot(m, s), { m: model, s: size });
    await p.page.waitForTimeout(250);
    return p.page.evaluate(() => ({ model: window.__crackioAgent.shotModel(), aspect: window.__crackioAgent.scene().aspect }));
  });
}

/**
 * The shot: the page's own Shoot from the camera as it stands, with the agent's words as the scene's notes. The job it
 * sends is marked as the agent's, pinned to the machine planned for it, and never enhanced.
 */
export function shoot(id: string, input: { notes: string; machine?: string; mark: Record<string, unknown> }): Promise<string> {
  const p = place(id);
  return inTurn(p, async () => {
    let job: string | null = null;
    let refused: string | null = null;
    const through = async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      const body = JSON.parse(request.postData() ?? "{}") as { refine?: boolean; params?: Record<string, unknown> & { options?: Record<string, unknown> } };
      body.refine = false;
      body.params = { ...body.params, agent: input.mark, options: { ...body.params?.options, ...(input.machine ? { machine: input.machine } : {}) } };
      const response = await route.fetch({ postData: JSON.stringify(body) });
      const answer = (await response.json().catch(() => null)) as { item?: { id?: string }; error?: string } | null;
      job = answer?.item?.id ?? null;
      refused = answer?.error ?? (job ? null : `Crackio answered ${response.status()}.`);
      await route.fulfill({ response });
    };
    await p.page.route("**/api/generations", through);
    try {
      await p.page.evaluate((notes) => window.__crackioAgent.act("setScene", { notes }), input.notes);
      await p.page.waitForTimeout(200);
      await p.page.evaluate(() => window.__crackioAgent.shoot());
      // The page says what stopped it (no model picked, nothing on the set) in its own words.
      for (let waited = 0; !job && !refused && waited < 4000; waited += 200) await p.page.waitForTimeout(200);
      if (job) return job;
      const said = refused ?? (await p.page.evaluate(() => window.__crackioAgent.shootError()));
      throw fail("job_failed", { what: "The Director didn't start the shot.", why: said ?? "The page gave no reason.", do: "Fix what it says and shoot again. If it names a missing model, ask the user to set the Director up in Crackio → Settings → Tools." });
    } finally {
      await p.page.unroute("**/api/generations", through).catch(() => undefined);
    }
  });
}
