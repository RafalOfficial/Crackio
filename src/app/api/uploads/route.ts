import path from "node:path";
import { saveFileUpload, saveUpload } from "@/lib/server/media";
import { demoOwner, signInFirst } from "@/lib/demo/owner";
import { demoUploadAllowance, demoUploadProblem, noteUploads } from "@/lib/demo/media";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/x-m4v": "m4v" };
const AUDIO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/opus": "opus",
};
/** Small text files Motion can read: subtitles, scripts, lyrics, data. */
const TEXT_EXT = new Set(["txt", "srt", "ass", "vtt", "json", "csv", "md", "lrc", "svg"]);

export async function POST(request: Request) {
  // The live demo takes pictures and short clips from signed-in codes only, and remembers whose they are (lib/demo).
  const owner = await demoOwner(request);
  if (owner === null) return signInFirst();
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "Send the file as multipart form data." }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return Response.json({ error: "No file received." }, { status: 400 });

  const items = [];
  const allowance = owner ? demoUploadAllowance(owner, files) : null;
  if (allowance) return Response.json({ error: allowance }, { status: 413 });

  for (const file of files.slice(0, 24)) {
    const problem = owner ? await demoUploadProblem(file) : null;
    if (problem) return Response.json({ error: problem }, { status: 415 });
    const ext = path.extname(file.name).slice(1).toLowerCase();
    const media = VIDEO_EXT[file.type] ? { ext: VIDEO_EXT[file.type], kind: "video" as const } : AUDIO_EXT[file.type] ? { ext: AUDIO_EXT[file.type], kind: "audio" as const } : null;
    if (media) {
      if (file.size > MAX_MEDIA_BYTES) return Response.json({ error: `${file.name} is larger than 500 MB.` }, { status: 413 });
      items.push({ name: file.name, ...(await saveFileUpload(Buffer.from(await file.arrayBuffer()), media.ext, media.kind)) });
      continue;
    }
    if (TEXT_EXT.has(ext) && !file.type.startsWith("image/")) {
      if (file.size > MAX_TEXT_BYTES) return Response.json({ error: `${file.name} is larger than 2 MB.` }, { status: 413 });
      items.push({ name: file.name, ...(await saveFileUpload(Buffer.from(await file.arrayBuffer()), ext, "file")) });
      continue;
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: `${file.name} is larger than 25 MB.` }, { status: 413 });
    }
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      return Response.json({ error: `${file.name} isn't a file Crackio can use.` }, { status: 415 });
    }
    try {
      items.push({ name: file.name, ...(await saveUpload(Buffer.from(await file.arrayBuffer()))) });
    } catch {
      return Response.json({ error: `${file.name} couldn't be read as an image.` }, { status: 422 });
    }
  }
  if (owner) noteUploads(owner, items.map((i, n) => ({ url: i.url, bytes: files[n]?.size ?? 0 })));
  return Response.json({ items }, { status: 201 });
}
