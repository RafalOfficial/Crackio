import type { Metadata } from "next";
import { VideoTool } from "@/components/video/VideoTool";

export const metadata: Metadata = { title: "Video", description: "Bring a still to life, or write a shot from scratch, with the camera move you pick." };

export default function Page() {
  return <VideoTool />;
}
