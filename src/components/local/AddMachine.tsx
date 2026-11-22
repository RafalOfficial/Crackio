"use client";

import { useState } from "react";
import { LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Another computer running ComfyUI on the same network (a Mac next to the PC): its models run from here too. `bare`: the
 * page around it already says what it is (Settings → Machines' heading), so only the form shows.
 */
export function AddMachine({ onAdded, bare = false }: { onAdded: () => void; bare?: boolean }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setWorking(true);
    setProblem(null);
    try {
      const res = await fetch("/api/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add-machine", url: url.trim(), token: token.trim() || undefined }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setProblem(body.error ?? "That didn't work.");
      else {
        setUrl("");
        setToken("");
        onAdded();
      }
    } finally {
      setWorking(false);
    }
  }
  return (
    <form onSubmit={add} className={cn("surface squircle flex flex-col gap-3 rounded-panel", bare ? "p-4" : "p-5")}>
      {bare ? null : (
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-haze">Use another computer</p>
          <p className="mt-1 text-[13px] leading-relaxed text-fog">
            A Mac or PC on the same network running ComfyUI (started with <code className="text-paper">--listen</code>). Crackio installs models on it too, and sends each job to a
            machine that has its model, idle and fastest first.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.20:8188"
          aria-label="Its ComfyUI address"
          className="field-focus h-9 min-w-[200px] flex-1 rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token (if it asks)"
          type="password"
          aria-label="Its access token, if it needs one"
          className="field-focus h-9 w-[150px] rounded-[10px] bg-white/[0.05] px-3 text-[13px] text-paper outline-none placeholder:text-haze"
        />
        <button type="submit" disabled={working || !url.trim()} className="press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-white/[0.08] px-3.5 text-[13px] font-semibold text-fog hover:text-paper disabled:opacity-50">
          {working ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </div>
      {problem ? (
        <p className="flex items-start gap-1.5 text-[12.5px] text-tally">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {problem}
        </p>
      ) : null}
    </form>
  );
}
