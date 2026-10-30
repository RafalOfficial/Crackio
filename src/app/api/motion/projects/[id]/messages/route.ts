import { nanoid } from "nanoid";
import { z } from "zod";
import { saveGeneration } from "@/lib/server/db";
import { runner } from "@/lib/server/runner";
import { getProject, updateProject } from "@/lib/motion/store";
import type { Generation } from "@/lib/generations/types";

const Body = z.object({
  text: z.string().max(20_000).default(""),
  attachments: z
    .array(
      z.object({
        url: z.string().max(500),
        kind: z.enum(["image", "video", "audio", "file"]),
        name: z.string().max(200),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .max(24)
    .default([]),
  /** "auto" lets the agent pick the shape from the request. */
  aspect: z.enum(["auto", "16:9", "9:16", "1:1", "4:5", "21:9"]).default("auto"),
  model: z.string().max(120).default("auto"),
});

/** Add your message and start the agent on it, in the background. */
export async function POST(request: Request, ctx: RouteContext<"/api/motion/projects/[id]/messages">) {
  const { id } = await ctx.params;
  if (!(await getProject(id))) return Response.json({ error: "Project not found" }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const body = parsed.data;
  if (!body.text.trim() && !body.attachments.length) return Response.json({ error: "Say what to make, or attach something." }, { status: 400 });

  const now = Date.now();
  const userMessage = { id: nanoid(10), role: "user" as const, text: body.text.trim(), attachments: body.attachments, createdAt: now };
  const agentMessage = { id: nanoid(10), role: "agent" as const, text: "", log: [], createdAt: now + 1 };
  const gen: Generation = {
    id: nanoid(14),
    tool: "motion",
    engine: "auto",
    model: body.model,
    status: "queued",
    prompt: body.text.trim(),
    aspect: body.aspect === "auto" ? "16:9" : body.aspect,
    count: 1,
    references: body.attachments.filter((a) => a.kind === "image").map((a) => ({ url: a.url, label: a.name })),
    outputs: [],
    params: { kind: "motion", projectId: id, messageId: userMessage.id, agentMessageId: agentMessage.id, aspect: body.aspect },
    progress: 0,
    stage: "Queued",
    createdAt: now,
  };
  saveGeneration(gen);
  const project = await updateProject(id, (p) => {
    p.messages.push(userMessage, { ...agentMessage, generationId: gen.id });
  });
  runner().enqueue(gen.id);
  return Response.json({ project }, { status: 201 });
}
