import type { Metadata } from "next";
import { AccountsView } from "@/components/settings/AccountsView";

export const metadata: Metadata = { title: "Accounts · Settings" };

export default function AccountsPage() {
  return <AccountsView />;
}
