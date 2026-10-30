import Image from "next/image";
import Link from "next/link";
import { ToolTile } from "@/components/ui/ToolTile";
import { Badge } from "@/components/ui/Badge";
import { TOOLS } from "@/lib/tools";
import { DEMO, demoToolSlug } from "@/lib/demo/config";

export function ToolGrid() {
  return (
    <section aria-labelledby="tools-heading" id="tools" className="scroll-mt-24">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="tools-heading" className="font-display text-[28px] sm:text-[34px]">
          Ten tools, done properly
        </h2>
        <p className="hidden text-[14px] text-fog md:block">Each one runs on the plans and engines you connect.</p>
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 lg:gap-x-4">
        {(DEMO ? TOOLS.filter((tool) => demoToolSlug(tool.slug)) : TOOLS).map((tool) => (
          <li key={tool.slug}>
            <Link href={tool.href} className="group block">
              <div className="relative aspect-[4/3] overflow-hidden rounded-[14px] bg-apple">
                <Image
                  src={tool.media}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 20vw, (min-width: 640px) 33vw, 50vw"
                  className="object-cover transition-transform duration-700 ease-[var(--ease-out-quint)] group-hover:scale-[1.04]"
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <ToolTile icon={tool.icon} hue={tool.hue} size={24} />
                <span className="truncate text-[15px] font-semibold">{tool.name}</span>
                {tool.badge ? <Badge tone={tool.badge} className="ml-auto shrink-0" /> : null}
              </div>
              <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-fog">{tool.summary}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
