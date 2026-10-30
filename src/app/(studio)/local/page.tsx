import type { Metadata } from "next";
import { LocalView } from "@/components/local/LocalView";

export const metadata: Metadata = { title: "Local", description: "The best open image and video models on your own hardware: free, private, installed into ComfyUI in one click." };

export default function Page() {
  return <LocalView />;
}
