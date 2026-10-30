import { SettingsNav } from "@/components/settings/SettingsNav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="mx-auto max-w-[1040px] px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pt-10">
      <SettingsNav />
      {children}
    </div>
  );
}
