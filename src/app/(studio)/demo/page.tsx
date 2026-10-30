import type { Metadata } from "next";
import { DemoSignIn } from "@/components/demo/DemoSignIn";

export const metadata: Metadata = { title: "Live demo" };

export default function DemoPage() {
  return <DemoSignIn />;
}
