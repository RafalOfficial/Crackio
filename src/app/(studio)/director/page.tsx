import type { Metadata } from "next";
import { DirectorClient } from "@/components/director/DirectorClient";

export const metadata: Metadata = {
  title: "Director",
  description: "Stage people, products and places on a set, aim the camera, and generate the shot you pictured.",
};

export default function DirectorPage() {
  return <DirectorClient />;
}
