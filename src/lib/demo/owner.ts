import "server-only";
import { demoOn } from "./config";
import { sessionOf } from "./session";

/**
 * Whose work a request may see. Outside the live demo: undefined, and everything is yours. In the demo: the signed-in
 * access code's id, or null for a visitor without one, who sees nothing.
 */
export async function demoOwner(request: Request): Promise<string | null | undefined> {
  return demoOn() ? sessionOf(request) : undefined;
}

/** Whether a request's owner may see something made by `owner`. */
export const maysee = (viewer: string | null | undefined, owner: string | undefined) => viewer === undefined || (viewer !== null && owner === viewer);

/** For a route: the answer when a demo visitor isn't signed in. */
export const signInFirst = () => Response.json({ error: "Enter your access code first (top of the page)." }, { status: 401 });
