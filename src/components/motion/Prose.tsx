import type { ReactNode } from "react";

/**
 * The agent's words, with the little markdown models write anyway: paragraphs, lists, **bold**,
 * *italic*, `code` and links. Built as elements, never as HTML, so nothing in the text can run.
 */
const INLINE = /\*\*(.+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k} className="font-semibold">{inline(m[1], k)}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k} className="rounded bg-white/[0.07] px-1 py-px font-mono text-[0.9em]">{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<Link key={k} href={m[4]}>{m[3]}</Link>);
    else if (m[5] !== undefined) out.push(<Link key={k} href={m[5]}>{m[5]}</Link>);
    else if (m[6] !== undefined) out.push(<em key={k}>{m[6]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="break-all text-paper underline decoration-white/30 underline-offset-2 hover:decoration-white/70">
      {children}
    </a>
  );
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

export function Prose({ text, className }: { text: string; className?: string }) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n{2,}/);
  return (
    <div className={className}>
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const key = `b${b}`;
        const list = lines.length > 0 && (lines.every((l) => BULLET.test(l)) ? "ul" : lines.every((l) => NUMBER.test(l)) ? "ol" : null);
        if (list) {
          const Tag = list;
          return (
            <Tag key={key} className={`${b ? "mt-2" : ""} space-y-1 pl-5 ${list === "ul" ? "list-disc" : "list-decimal"}`}>
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(list === "ul" ? BULLET : NUMBER, ""), `${key}-${i}`)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={key} className={b ? "mt-2" : undefined}>
            {lines.map((l, i) => (
              <span key={i}>
                {i ? <br /> : null}
                {inline(l.replace(/^#{1,6}\s+/, ""), `${key}-${i}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
