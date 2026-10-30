import Image from "next/image";
import Link from "next/link";
import { AppIcon, ToolTile } from "@/components/ui/ToolTile";
import { Badge } from "@/components/ui/Badge";
import { toolBySlug } from "@/lib/tools";
import { HoverClip } from "./HoverClip";

const director = toolBySlug("director")!;
const motion = toolBySlug("motion")!;

/** Video is a page like Image, not a tool, so it carries its own card details. `clip` plays on hover. */
const FEATURED = [
  {
    href: director.href,
    name: director.name,
    media: "/assets/feature-director.webp",
    clip: undefined,
    line: "Stage your subjects on a set, aim the camera, and generate the shot you pictured.",
    mark: <ToolTile icon={director.icon} hue={director.hue} size={30} />,
    badge: director.badge,
  },
  {
    href: "/video",
    name: "Video",
    media: "/assets/feature-video.webp",
    clip: "/assets/feature-video.mp4",
    line: "Animate any still with the camera move you pick, up to 15 seconds with sound.",
    mark: <AppIcon glyph="/icons/video.png" size={30} />,
    badge: undefined,
  },
  {
    href: motion.href,
    name: motion.name,
    media: "/assets/feature-motion.webp",
    clip: undefined,
    line: "An agent with real tools: it generates, designs, edits and renders any video you describe.",
    mark: <ToolTile icon={motion.icon} hue={motion.hue} size={30} />,
    badge: "New" as const,
  },
];

export function FeaturedRow() {
  return (
    <section aria-label="Featured tools" className="grid gap-x-4 gap-y-7 md:grid-cols-3">
      {FEATURED.map((f, i) => (
        <Link key={f.href} href={f.href} className="group block">
          <div className="relative aspect-[16/10] overflow-hidden rounded-card bg-apple">
            <Image
              src={f.media}
              alt=""
              fill
              priority={i === 0}
              sizes="(min-width: 768px) 33vw, 100vw"
              className="object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.035]"
            />
            {f.clip ? <HoverClip src={f.clip} /> : null}
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/45 to-transparent" />
            <div className="absolute left-3 top-3 flex items-center gap-2">
              {f.mark}
              {f.badge ? <Badge tone={f.badge} /> : null}
            </div>
          </div>
          <h3 className="mt-3.5 font-display text-[19px] uppercase tracking-[-0.01em]">{f.name}</h3>
          <p className="mt-1 max-w-[46ch] text-[14px] leading-relaxed text-fog">{f.line}</p>
        </Link>
      ))}
    </section>
  );
}
