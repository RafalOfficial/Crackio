"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/models", label: "Models" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="squircle inline-flex rounded-[14px] bg-white/[0.05] p-0.5">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={pathname.startsWith(t.href) ? "page" : undefined}
          className={cn(
            "press squircle rounded-[12px] px-4 py-1.5 text-[13px] font-semibold",
            pathname.startsWith(t.href) ? "bg-white/[0.14] text-paper shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-fog hover:text-paper",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
