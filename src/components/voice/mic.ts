"use client";

/** What stops the Voice page from using the microphone, in words a person can act on (Clone's recorder, Talk). */

/** `secure`: the page is on a plain http network address, and Crackio's https one would let it use the mic. */
export type MicProblem = { title: string; body: string; secure?: boolean };

export const mac = () => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const safari = () => /^((?!chrome|chromium|crios|android|edg).)*safari/i.test(navigator.userAgent);

/**
 * Why this page can't open the microphone at all, before trying. Browsers only open it on https or on the computer
 * itself, so http://192.168.x.x (Crackio on another computer) can't; Crackio's secure address can.
 */
export function cantUseMic(what: string): MicProblem | null {
  if (typeof navigator.mediaDevices?.getUserMedia === "function") return null;
  if (!window.isSecureContext)
    return {
      title: `${what} needs Crackio's secure address`,
      body: `Browsers only let a page use the microphone on https or on the computer it runs on, and this is http://${location.host}.`,
      secure: true,
    };
  return { title: "This browser can't use a microphone", body: "Use a current Chrome, Edge, Safari or Firefox." };
}

/** What went wrong opening the microphone, and where to fix it; `again` names the button to press after. */
export function micProblem(err: unknown, again: string, instead = ", or upload a recording instead"): MicProblem {
  const name = (err as DOMException | undefined)?.name ?? "";
  const system = mac() ? "System Settings → Privacy & Security → Microphone, and turn your browser on" : "Windows Settings → Privacy & security → Microphone, and turn on “Microphone access” and “Let desktop apps access your microphone”";
  const site = safari() ? "In Safari’s menu: Settings for This Website → Microphone → Allow" : "Click the icon at the left of the address bar, set Microphone to Allow";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return { title: "The microphone is blocked for Crackio", body: `${site}, then press ${again} again. Still blocked? Open ${system}.` };
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return { title: "No microphone found", body: `Plug one in and press ${again} again${instead}.` };
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return { title: "The microphone didn't start", body: `Another app may be holding it (a call, a recorder), or the system blocks it: ${system}.` };
  return { title: "The microphone didn't start", body: (err as Error)?.message || String(err) };
}
