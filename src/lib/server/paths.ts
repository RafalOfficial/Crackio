import "server-only";
import path from "node:path";

/** Everything Crackio stores lives here. Gitignored, local to this machine. */
// Runtime data, not source: keep the bundler from tracing it into the build.
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.CRACKIO_DATA_DIR || path.join(process.cwd(), "data"));
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
/** Template clips kept on this computer only (never shipped). */
export const TEMPLATES_DIR = path.join(DATA_DIR, "templates");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const DB_FILE = path.join(DATA_DIR, "crackio.db");
