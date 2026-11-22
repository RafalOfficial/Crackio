import { z } from "zod";
import { noteAddress } from "@/lib/agent/address";
import { agentClis, checkProgram, connectCli, programPath, removeCli } from "@/lib/agent/connect";
import { agentPrefs, setAgentPrefs } from "@/lib/agent/prefs";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { netAddresses } from "@/lib/server/net-addresses";

/**
 * Settings → Agents: the agent CLIs on this computer and whether each has Crackio's MCP program, what the user lets
 * agents do, and the command for an agent on another computer. POST connects or removes one, or changes a switch.
 */
export async function GET(request: Request) {
  // The MCP program finds this Crackio by the address noted here, whatever port it runs on.
  await noteAddress();
  const check = new URL(request.url).searchParams.get("check") === "1";
  const port = process.env.PORT || "3000";
  const lan = netAddresses().find((a) => a.family === "IPv4" && !a.internal)?.address ?? null;
  const [clis, prefs, program] = await Promise.all([agentClis(), agentPrefs(), check ? checkProgram() : null]);
  return Response.json(
    {
      clis,
      prefs,
      tools: AGENT_TOOLS.length,
      program: { path: programPath(), ...(program ? { check: program } : {}) },
      // For an agent on another computer of yours: it fetches the program from this Crackio and points it back here.
      remote: lan ? { url: `http://${lan}:${port}`, program: `http://${lan}:${port}/api/agent/program` } : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const Body = z.union([
  z.object({ action: z.enum(["connect", "remove"]), id: z.enum(["claude", "codex", "cursor", "grok", "opencode", "gemini", "antigravity"]) }),
  z.object({ action: z.literal("prefs"), enabled: z.boolean().optional(), spend: z.enum(["free", "confirm", "all"]).optional(), agreed: z.boolean().optional(), seePictures: z.boolean().optional() }),
]);

/** A request a browser sent from Crackio's own pages (not a script, not an agent, not another site). */
function fromOurScreen(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return Boolean(origin && host && new URL(origin).host === host);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.action === "prefs") {
      const { action: _a, agreed, ...patch } = body;
      void _a;
      // "Allow everything" lets agents spend without asking: it is switched on by the user, on Crackio's own screen,
      // after they said so. Never by a script or an agent.
      if (patch.spend === "all" && !(agreed === true && fromOurScreen(request))) {
        return Response.json({ error: "Only you can switch this on: Crackio → Settings → Agents." }, { status: 403 });
      }
      return Response.json({ prefs: await setAgentPrefs(patch) });
    }
    const cli = body.action === "connect" ? await connectCli(body.id) : await removeCli(body.id);
    // Connected: say whether the program itself reaches Crackio, which is what the agent will find.
    return Response.json({ cli, ...(body.action === "connect" ? { check: await checkProgram() } : {}) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
