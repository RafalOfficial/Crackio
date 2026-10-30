/**
 * Pictures a prompt can name. Each picture attached to a prompt box has a tag ("REF 2"), a word that mentions it
 * ("@ref2", offered by the "@" menu, see components/cast/Mentions) and what the model reads instead ("reference image 2",
 * matching the label its picture is sent with).
 */
export type NamedPicture = { token: string; said: string };

const WORD = /(^|[^\w@])@(start|end|ref\d{1,2})\b/gi;

/** The words as the model reads them: "@start" is "the start frame", "@ref2" "reference image 2". Other @words stay (Cast). */
export function sayPictures(text: string, named: NamedPicture[]) {
  return text.replace(WORD, (all, lead: string, word: string) => {
    const found = named.find((n) => n.token === word.toLowerCase());
    return found ? lead + found.said : all;
  });
}

/** What a reference is called, to the model and in the prompt. */
export const referenceName = (n: number) => ({ token: `ref${n}`, tag: `Ref ${n}`, label: `Reference ${n}`, said: `reference image ${n}` });
