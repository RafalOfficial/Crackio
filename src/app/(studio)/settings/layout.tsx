import { Suspense } from "react";
import { SettingsShell } from "@/components/settings/SettingsShell";

/** Settings' rail of sections around every settings page (components/settings/SettingsShell). */
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <Suspense>
      <SettingsShell>{children}</SettingsShell>
    </Suspense>
  );
}
