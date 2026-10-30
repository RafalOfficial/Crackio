import os from "node:os";
import type { NextConfig } from "next";

/**
 * Hostnames allowed to load the dev server's own resources (HMR, dev chunks).
 * Next.js only trusts localhost by default; without this, opening Crackio from another
 * device on your network (http://192.168.x.x:3000) never finishes booting, because the
 * dev client waits on a websocket Next.js refuses for unknown origins.
 * We allow every address this machine currently has, its hostname, and anything listed
 * in CRACKIO_ALLOWED_ORIGINS (comma-separated, e.g. a tunnel domain).
 */
function devOrigins() {
  const hosts = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) hosts.add(a.address);
  }
  // Loopback by IP: OpenAI's sign-in sends you back to http://127.0.0.1 (never "localhost"),
  // and Next only trusts the name "localhost", so that page would never finish loading.
  hosts.add("127.0.0.1");
  const name = os.hostname().toLowerCase();
  hosts.add(name);
  hosts.add(`${name}.local`);
  hosts.add("*.local");
  for (const extra of (process.env.CRACKIO_ALLOWED_ORIGINS ?? "").split(",")) {
    const h = extra.trim().replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
    if (h) hosts.add(h);
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Motion renders on this computer: headless Chrome and ffmpeg stay plain Node packages.
  // Director's depth and cutout models run on onnxruntime's native binaries.
  serverExternalPackages: ["playwright-core", "ffmpeg-static", "@ffmpeg-installer/ffmpeg", "onnxruntime-node"],
  // Your data and the local art and scratch folders are read from disk at run time, never shipped: keep
  // them out of build traces (a browser profile left open in assets-src/tmp made `next build` fail).
  outputFileTracingExcludes: { "/*": ["./assets-src/**/*", "./data/**/*", "./.research/**/*", "./*.mp4"] },
  allowedDevOrigins: devOrigins(),
  devIndicators: { position: "bottom-right" },
  // src/proxy.ts makes Next buffer each request body, by default only its first 10 MB: bigger clips and files (the
  // uploads route takes up to 500 MB) arrived cut off.
  experimental: { proxyClientMaxBodySize: "512mb" },
  // The hosted live demo (docs/DEMO.md): pages learn at build time whether they're in it and which tools it offers.
  env: {
    NEXT_PUBLIC_CRACKIO_DEMO: process.env.CRACKIO_DEMO === "1" ? "1" : "",
    NEXT_PUBLIC_CRACKIO_DEMO_TOOLS: process.env.CRACKIO_DEMO_TOOLS ?? "",
    NEXT_PUBLIC_CRACKIO_REPO: process.env.CRACKIO_REPO ?? "",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
