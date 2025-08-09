"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type JobState =
  | "idle"
  | "queued"
  | "extracting"
  | "transcribing"
  | "understanding"
  | "synthesizing"
  | "validating"
  | "completed"
  | "failed";

type Recipe = {
  title: string;
  servings: number;
  time: { total: string; active: string };
  ingredients: Array<{ quantity: number; unit: string; item: string; prep?: string }>;
  equipment: string[];
  steps: Array<{ n: number; text: string; time_hint?: string }>;
  notes: string[];
  allergens: string[];
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

export default function Home() {
  const [videoUrl, setVideoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [state, setState] = useState<JobState>("idle");
  const [events, setEvents] = useState<string[]>([]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [txt, setTxt] = useState<string>("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const canSubmit = useMemo(() => {
    return (videoUrl && videoUrl.trim().length > 0) || !!file;
  }, [videoUrl, file]);

  const handleSubmit = useCallback(async () => {
    setRecipe(null);
    setMarkdown("");
    setTxt("");
    setEvents([]);
    setState("queued");

    const payload: any = {
      filename: file?.name ?? "url.mp4",
      size_bytes: file?.size ?? 0,
      source_type: videoUrl ? "url" : "file",
      ...(videoUrl ? { source_url: videoUrl } : {}),
    };
    try {
      const cu = await fetch(`${API_BASE}/api/create-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!cu.ok) throw new Error(`create-upload failed: ${cu.status}`);
      const cuData = await cu.json();
      const sj = await fetch(`${API_BASE}/api/start-job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: cuData.upload_id }),
      });
      if (!sj.ok) throw new Error(`start-job failed: ${sj.status}`);
      const { job_id, sse_url } = await sj.json();
      setJobId(job_id);

      const es = new EventSource(`${API_BASE}${sse_url}`);
      esRef.current = es;
      const onAny = (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.state) setState(data.state as JobState);
        } catch {}
        setEvents((prev) => [...prev, `${evt.type}`]);
      };
      [
        "queued",
        "extracting",
        "transcribing",
        "understanding",
        "synthesizing",
        "validating",
        "completed",
        "failed",
        "message",
      ].forEach((t) => es.addEventListener(t, onAny as any));
      es.onerror = () => {
        // ignore transient errors during SSE
      };
      es.onopen = () => {
        setEvents((prev) => [...prev, "sse:open"]);
      };

      const poll = setInterval(async () => {
        if (!job_id) return;
        const st = await fetch(`${API_BASE}/api/jobs/${job_id}/status`);
        if (st.ok) {
          const j = await st.json();
          if (j.state) setState(j.state as JobState);
        }
      }, 1500);

      es.addEventListener("completed", async () => {
        clearInterval(poll);
        es.close();
        const tryFetch = async (attempt: number = 0) => {
          const r = await fetch(`${API_BASE}/api/get-recipe?job_id=${job_id}`);
          if (r.ok) {
            const data = await r.json();
            setRecipe(data.recipe_json);
            setMarkdown(data.markdown ?? "");
            setTxt(data.txt ?? "");
            return;
          }
          if (r.status === 425 && attempt < 60) {
            setTimeout(() => tryFetch(attempt + 1), 1000);
          }
        };
        tryFetch();
      });
    } catch (err) {
      console.error(err);
      setState("failed");
    }
  }, [API_BASE, file, videoUrl]);

  const download = useCallback((content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return (
    <div className="min-h-screen p-6 sm:p-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-2xl font-semibold">Video → Recipe</h1>
        <div className="space-y-3">
          <label className="block text-sm font-medium">Video URL</label>
          <input
            className="w-full border rounded px-3 py-2"
            placeholder="https://..."
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
          />
        </div>
        <div className="space-y-3">
          <label className="block text-sm font-medium">Or upload file</label>
          <input type="file" accept=".mp4,.mov,.mkv,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button
          className="px-4 py-2 bg-black text-white rounded disabled:opacity-50"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          Start
        </button>

        <div className="border rounded p-3">
          <div className="text-sm">Job: {jobId ?? "—"}</div>
          <div className="text-sm">State: {state}</div>
          <div className="text-xs text-gray-500 break-words">Events: {events.join(", ")}</div>
        </div>

        {recipe && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Recipe</h2>
            <div className="space-y-1">
              <div className="font-medium">{recipe.title}</div>
              <div className="text-sm">Servings: {recipe.servings}</div>
              <div className="text-sm">Time: total {recipe.time.total}, active {recipe.time.active}</div>
            </div>
            <div>
              <h3 className="font-medium">Ingredients</h3>
              <ul className="list-disc pl-5 text-sm">
                {recipe.ingredients.map((ing, idx) => (
                  <li key={idx}>
                    {ing.quantity} {ing.unit} {ing.item} {ing.prep ? `(${ing.prep})` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-medium">Equipment</h3>
              <ul className="list-disc pl-5 text-sm">
                {recipe.equipment.map((eq, idx) => (
                  <li key={idx}>{eq}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-medium">Instructions</h3>
              <ol className="list-decimal pl-5 text-sm space-y-1">
                {recipe.steps.map((s) => (
                  <li key={s.n}>
                    {s.text} {s.time_hint ? `(${s.time_hint})` : ""}
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-2 border rounded" onClick={() => download(JSON.stringify(recipe, null, 2), `${recipe.title}.json`, "application/json")}>
                Download JSON
              </button>
              <button className="px-3 py-2 border rounded" onClick={() => download(markdown, `${recipe.title}.md`, "text/markdown")}>Download MD</button>
              <button className="px-3 py-2 border rounded" onClick={() => download(txt, `${recipe.title}.txt`, "text/plain")}>Download TXT</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
