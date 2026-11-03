import type { Metadata } from "next";
import { DoctorView } from "@/components/settings/DoctorView";

export const metadata: Metadata = { title: "Doctor · Settings" };

export default function DoctorPage() {
  return <DoctorView />;
}
