import { redirect } from "next/navigation";

/**
 * Local moved into Settings: machines under Machines, what to set up on each under Tools, every open model in the model
 * library's Get models. Old links (and bookmarks) land on Tools.
 */
export default function Page() {
  redirect("/settings/tools");
}
