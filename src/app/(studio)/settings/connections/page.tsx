import { redirect } from "next/navigation";

/** Connections moved into Settings: keys under Accounts, machines under Machines. */
export default function ConnectionsPage() {
  redirect("/settings/accounts");
}
