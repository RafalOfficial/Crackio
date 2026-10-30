import type { Metadata, Viewport } from "next";
import { Funnel_Display, Funnel_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Funnel_Display({ variable: "--font-funnel-display", subsets: ["latin"], display: "swap" });
const sans = Funnel_Sans({ variable: "--font-funnel-sans", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Crackio — open-source AI studio",
    template: "%s · Crackio",
  },
  description:
    "Stage your shot instead of guessing the prompt. Crackio is an open-source studio for images and video, built on ComfyUI.",
  applicationName: "Crackio",
};

export const viewport: Viewport = {
  themeColor: "#16131b",
  colorScheme: "dark",
};

/**
 * The composer chip's last size ("· 2K", in its tier's color; components/dashboard/ComposerControls `SizeHint`), set on
 * <html> as CSS variables while the HTML is read, so the chip shows it from the first paint. It runs once, here in the
 * server-rendered <head>; the attribute it adds to <html> is why that element skips the hydration check.
 */
const SIZE_HINT_SCRIPT = `(function(){try{var h=JSON.parse(localStorage.getItem("crackio:size-hint")||"{}"),r=document.documentElement.style;for(var k in h){var v=h[k];if(!/^[a-z0-9-]+$/.test(k)||!v||!v.s)continue;r.setProperty("--size-hint-"+k,JSON.stringify("· "+v.s));if(v.c)r.setProperty("--size-hint-"+k+"-color",v.c)}}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIZE_HINT_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
