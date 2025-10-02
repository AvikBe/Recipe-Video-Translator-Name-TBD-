"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "./contexts/ThemeContext";
import Header from "./components/Header";
import { PaperAirplaneIcon, PaperclipIcon, DownloadIcon } from "./components/Icons";

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
  const { isDark, toggleTheme } = useTheme();
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

  type CreateUploadPayload =
    | { filename: string; size_bytes: number; source_type: "file" }
    | { filename: string; size_bytes: number; source_type: "url"; source_url: string };

  const handleSubmit = useCallback(async () => {
    setRecipe(null);
    setMarkdown("");
    setTxt("");
    setEvents([]);
    setState("queued");

    const payload: CreateUploadPayload = videoUrl
      ? {
          filename: "url.mp4",
          size_bytes: 0,
          source_type: "url",
          source_url: videoUrl,
        }
      : {
          filename: file?.name ?? "file.mp4",
          size_bytes: file?.size ?? 0,
          source_type: "file",
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
      const onAny: EventListener = (evt) => {
        const me = evt as MessageEvent;
        try {
          const data = JSON.parse(String(me.data));
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
      ].forEach((t) => es.addEventListener(t, onAny));
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
  }, [file, videoUrl]);

  const download = useCallback((content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // If we have a recipe, show the recipe display page
  if (recipe) {
    return (
      <div 
        className="min-h-screen"
        style={{ backgroundColor: isDark ? 'var(--dark-bg)' : 'var(--light-bg)' }}
      >
        <Header isDark={isDark} onToggleTheme={toggleTheme} />
        <div className="max-w-4xl mx-auto px-6 py-12">
          <div style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}>
            {/* Recipe Title and Metadata - Exact layout from design */}
            <div className="flex flex-col md:flex-row md:justify-between md:items-start mb-8 space-y-4 md:space-y-0">
              <h1 className="text-2xl md:text-3xl font-bold font-sans">{recipe.title}:</h1>
              <div className="text-left md:text-right font-sans" style={{ color: isDark ? 'var(--dark-placeholder)' : 'var(--light-placeholder)' }}>
                <p className="text-sm mb-1">Serves: {recipe.servings}</p>
                <p className="text-sm">Total preparation time: {recipe.time.total}</p>
              </div>
            </div>

            {/* Ingredients */}
            <div className="mb-8">
              <h2 className="text-xl font-bold mb-4 font-sans">Ingredients:</h2>
              <ul className="space-y-2 font-sans">
                {recipe.ingredients.map((ing, idx) => (
                  <li key={idx} className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>
                      {ing.quantity} {ing.unit} {ing.item} {ing.prep ? `(${ing.prep})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Instructions */}
            <div className="mb-8">
              <h2 className="text-xl font-bold mb-4 font-sans">Instructions:</h2>
              <ol className="space-y-3 font-sans">
                {recipe.steps.map((s) => (
                  <li key={s.n} className="flex items-start">
                    <span className="mr-3 font-bold">{s.n}.</span>
                    <span>
                      {s.text} {s.time_hint ? `(${s.time_hint})` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Download Button - Exact styling from design */}
            <button 
              className="flex items-center space-x-2 px-6 py-3 rounded-lg font-medium transition-colors font-sans"
              style={{
                backgroundColor: isDark ? 'var(--dark-download-bg)' : 'var(--light-download-bg)',
                color: isDark ? 'var(--dark-download-text)' : 'var(--light-download-text)'
              }}
              onClick={() => download(markdown, `${recipe.title}.md`, "text/markdown")}
            >
              <DownloadIcon className="w-5 h-5" />
              <span>Download recipe</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main home page
  return (
    <div 
      className="min-h-screen"
      style={{ backgroundColor: isDark ? 'var(--dark-bg)' : 'var(--light-bg)' }}
    >
      <Header isDark={isDark} onToggleTheme={toggleTheme} />
      
      <div className="max-w-6xl mx-auto px-6 py-24">
        {/* Hero Content - Left-aligned text block */}
        <div className="max-w-2xl text-center md:text-left">
          {/* Hero Title - Exact typography from Figma */}
          <h1 
            className="text-5xl hero-title mb-4 leading-tight font-sans"
            style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
          >
            <div>Watch Less,</div>
            <div>Cook <span className="font-serif italic font-normal">More</span></div>
          </h1>
          
          {/* Subtitle */}
          <p 
            className="text-xl mb-8 hero-subtitle font-sans"
            style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
          >
            Paste a link. Get the recipe. Eat sooner.
          </p>

          {/* Input Section */}
          <div className="space-y-6">
            {/* Video URL Input */}
            <div className="relative">
              <input
                type="text"
                placeholder="Insert a valid video URL"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="w-full px-4 py-4 pr-12 rounded-lg text-lg font-normal focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans"
                style={{
                  backgroundColor: isDark ? 'var(--dark-input-bg)' : 'var(--light-input-bg)',
                  color: isDark ? 'var(--dark-text)' : 'var(--light-text)',
                  border: `1px solid ${isDark ? 'var(--dark-border)' : 'var(--light-border)'}`
                }}
              />
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-2 transition-colors"
                style={{
                  color: canSubmit 
                    ? (isDark ? 'var(--dark-text)' : 'var(--light-text)')
                    : (isDark ? 'var(--dark-placeholder)' : 'var(--light-placeholder)')
                }}
              >
                <PaperAirplaneIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Divider with lines */}
            <div className="flex items-center space-x-4">
              <div 
                className="flex-1 h-px"
                style={{ backgroundColor: isDark ? 'var(--dark-border)' : 'var(--light-border)' }}
              ></div>
              <div 
                className="text-sm font-normal font-sans px-2"
                style={{ color: isDark ? 'var(--dark-text)' : 'var(--light-text)' }}
              >
                or
              </div>
              <div 
                className="flex-1 h-px"
                style={{ backgroundColor: isDark ? 'var(--dark-border)' : 'var(--light-border)' }}
              ></div>
            </div>

            {/* File Upload Button */}
            <div className="flex justify-center md:justify-start">
              <div className="relative">
                <input
                  type="file"
                  accept=".mp4,.mov,.mkv,.webm"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  id="file-upload"
                />
                <label
                  htmlFor="file-upload"
                  className="flex items-center justify-center space-x-2 px-4 py-2 rounded-full font-normal transition-colors cursor-pointer font-sans border"
                  style={{
                    backgroundColor: isDark ? 'var(--dark-input-bg)' : 'var(--light-input-bg)',
                    color: isDark ? 'var(--dark-text)' : 'var(--light-text)',
                    borderColor: isDark ? 'var(--dark-border)' : 'var(--light-border)'
                  }}
                >
                  <PaperclipIcon className="w-4 h-4" />
                  <span>Attach file</span>
                </label>
              </div>
            </div>

            {/* File name display */}
            {file && (
              <p 
                className="text-sm font-sans"
                style={{ color: isDark ? 'var(--dark-placeholder)' : 'var(--light-placeholder)' }}
              >
                Selected: {file.name}
              </p>
            )}

            {/* Status Display */}
            {state !== "idle" && (
              <div 
                className="p-4 rounded-lg font-sans"
                style={{
                  backgroundColor: isDark ? 'var(--dark-input-bg)' : 'var(--light-input-bg)',
                  color: isDark ? 'var(--dark-text)' : 'var(--light-text)',
                  border: `1px solid ${isDark ? 'var(--dark-border)' : 'var(--light-border)'}`
                }}
              >
                <div className="text-sm">
                  <div>Job: {jobId ?? "—"}</div>
                  <div>State: {state}</div>
                  {events.length > 0 && (
                    <div className="text-xs opacity-75 break-words">
                      Events: {events.join(", ")}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
