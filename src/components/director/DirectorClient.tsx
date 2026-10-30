"use client";

import dynamic from "next/dynamic";

/**
 * Director runs entirely in the browser: the scene lives in local storage and the stage is WebGL,
 * so there's nothing useful to render on the server.
 */
export const DirectorClient = dynamic(() => import("./DirectorWorkspace").then((m) => m.DirectorWorkspace), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:h-dvh lg:grid-cols-[300px_minmax(0,1fr)_330px] lg:py-4">
      <div className="skeleton hidden rounded-panel lg:block" />
      <div className="skeleton h-[58vh] rounded-panel lg:h-auto" />
      <div className="skeleton hidden rounded-panel lg:block" />
    </div>
  ),
});
