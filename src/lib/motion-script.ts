/** Where the motion preference lives in this browser (lib/motion-pref). Plain module: the root layout reads it too. */
export const MOTION_KEY = "crackio:motion";

/** Runs in <head> before anything paints (app/layout.tsx), so the first frame already moves the chosen way. */
export const MOTION_SCRIPT = `(function(){try{var m=localStorage.getItem("${MOTION_KEY}");if(m==="full"||m==="calm")document.documentElement.dataset.motion=m}catch(e){}})()`;
