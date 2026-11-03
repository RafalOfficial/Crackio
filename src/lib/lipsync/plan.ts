import type { LipAnalysis, LipRegion, LipSentence, LipWord } from "./types";

/** Words compared as words: case, punctuation and spacing don't count as a change. */
export const sameWords = (a: string, b: string) => bare(a) === bare(b);
const bare = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Changed sentences this close (seconds) are one stretch: one new take and one run of mouths. */
const JOIN_BELOW = 0.5;
/** The new words stop this long before the next words that stay. */
const BREATH = 0.08;

/**
 * The stretches to make anew from the edited sentences (by id): runs of changed sentences, each with the time the old
 * words took and how far the new ones may run (to just before the next sentence that stays, or the clip's end).
 */
export function regionsOf(analysis: Pick<LipAnalysis, "sentences" | "duration">, edited: Record<number, string>): LipRegion[] {
  const s = analysis.sentences;
  const changed = s.map((x) => edited[x.id] !== undefined && !sameWords(edited[x.id], x.text));
  const regions: LipRegion[] = [];
  let i = 0;
  while (i < s.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < s.length && changed[j + 1] && s[j + 1].start - s[j].end < JOIN_BELOW) j++;
    const next = s.slice(j + 1).find((x, k) => !changed[j + 1 + k]);
    const until = Math.max(s[j].end, (next ? next.start : analysis.duration) - BREATH);
    // And how early they may start: just after the words before that stay.
    const before = [...s.slice(0, i)].reverse().find((x, k) => !changed[i - 1 - k]);
    const from = Math.min(s[i].start, Math.max(0, (before ? before.end : 0) + BREATH));
    regions.push({
      from,
      start: s[i].start,
      end: s[j].end,
      until,
      was: s
        .slice(i, j + 1)
        .map((x) => x.text)
        .join(" "),
      text: s
        .slice(i, j + 1)
        .map((x) => (edited[x.id] ?? x.text).trim())
        .filter(Boolean)
        .join(" "),
      sentences: s.slice(i, j + 1).map((x) => x.id),
    });
    i = j + 1;
  }
  return regions;
}

/**
 * The sentences of what was heard, timed: the words as the aligner timed them (bare) put back onto the heard text's
 * own words (with punctuation), in order, then cut at the end of each sentence.
 */
export function sentencesOf(heard: string, words: LipWord[]): { words: LipWord[]; sentences: LipSentence[] } {
  const tokens = heard.split(/\s+/).filter(Boolean);
  const timed: LipWord[] = [];
  let w = 0;
  for (const token of tokens) {
    const want = bare(token).replace(/ /g, "");
    if (!want) continue;
    // The aligner's next word, or one a little further on (it can split or drop a word).
    let hit = -1;
    for (let k = w; k < Math.min(words.length, w + 3); k++) {
      if (bare(words[k].word).replace(/ /g, "") === want) {
        hit = k;
        break;
      }
    }
    if (hit < 0 && w < words.length) hit = w;
    if (hit < 0) break;
    timed.push({ word: token, start: words[hit].start, end: words[hit].end });
    w = hit + 1;
  }
  const sentences: LipSentence[] = [];
  let from = 0;
  timed.forEach((t, k) => {
    const last = k === timed.length - 1;
    const ends = /[.!?…]["'”’)\]]*$/.test(t.word);
    // A long pause ends a sentence too, when nothing was written to end it.
    const pause = !last && timed[k + 1].start - t.end > 0.7;
    if (ends || last || pause) {
      const part = timed.slice(from, k + 1);
      sentences.push({ id: sentences.length, text: part.map((p) => p.word).join(" "), start: part[0].start, end: part[part.length - 1].end });
      from = k + 1;
    }
  });
  return { words: timed, sentences };
}
