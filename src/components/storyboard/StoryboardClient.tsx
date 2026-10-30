"use client";

import dynamic from "next/dynamic";

/**
 * Storyboard runs in the browser: the film plays from media elements and the Director's stage is WebGL, so there's
 * nothing useful to render on the server.
 */
export const StoryboardClient = dynamic(() => import("./StoryboardApp").then((m) => m.StoryboardApp), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 gap-3 p-3 pt-[72px] sm:p-4 sm:pt-[76px] lg:h-dvh lg:grid-cols-[300px_minmax(0,1fr)_330px] lg:py-4 lg:pt-[76px]">
      <div className="skeleton hidden rounded-panel lg:block" />
      <div className="skeleton h-[58vh] rounded-panel lg:h-auto" />
      <div className="skeleton hidden rounded-panel lg:block" />
    </div>
  ),
});
