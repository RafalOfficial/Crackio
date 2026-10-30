const SHORT: Record<string, string> = {
  "comfy-cloud": "Comfy",
  "comfy-local": "ComfyUI",
};

export const engineShortName = (id: string) => SHORT[id] ?? id;
