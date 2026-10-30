import { ShellFrame } from "@/components/shell/ShellFrame";

export default function StudioLayout({ children }: LayoutProps<"/">) {
  return <ShellFrame>{children}</ShellFrame>;
}
