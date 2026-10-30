import "server-only";

/**
 * What's said in a clip, word by word with times. Crackio has no speech-to-text of its own (the one it used came with
 * the closed providers it no longer connects), so this answers null and the checks that need it are skipped.
 */
export type Transcript = { text: string; words: { text: string; start: number; end: number; speaker?: number }[]; speakers: number };

export async function transcribe(file: string, opts: { signal?: AbortSignal; terms?: string[] } = {}): Promise<Transcript | null> {
  void file;
  void opts;
  return null;
}
