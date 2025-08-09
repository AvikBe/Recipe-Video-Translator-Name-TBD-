import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export const router = Router();

// In-memory state (MVP only)
type UploadRecord = {
  source_type: 'file' | 'url';
  source_url?: string;
  filename: string;
  size_bytes: number;
};
const uploads = new Map<string, UploadRecord>();
type JobResult = { recipe_json: any; markdown: string; txt: string };
const jobResults = new Map<string, JobResult>();

// Schemas (minimal MVP contracts)
// Allow size_bytes === 0 when source_type is 'url', but require > 0 for 'file'
const CreateUploadReq = z.union([
  z.object({
    filename: z.string(),
    size_bytes: z.number().int().positive(),
    source_type: z.literal('file')
  }),
  z.object({
    filename: z.string(),
    size_bytes: z.number().int().nonnegative(),
    source_type: z.literal('url'),
    source_url: z.string().url()
  })
]);

router.post('/create-upload', (req: Request, res: Response) => {
  const parse = CreateUploadReq.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid_request', message: parse.error.message });
  const upload_id = 'upl_' + randomUUID();
  const body = parse.data as z.infer<typeof CreateUploadReq>;
  // Persist minimal upload info in-memory for Start Job
  if ('source_type' in body) {
    uploads.set(upload_id, {
      source_type: (body as any).source_type,
      source_url: (body as any).source_url,
      filename: (body as any).filename,
      size_bytes: (body as any).size_bytes,
    });
  }
  // Mocked S3 form fields
  return res.json({ upload_id, s3_fields: { url: 'https://s3.amazonaws.com/bucket', fields: { key: `uploads/${upload_id}` } } });
});

const StartJobReq = z.object({ upload_id: z.string().min(1) });
router.post('/start-job', (req: Request, res: Response) => {
  const parse = StartJobReq.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid_request', message: parse.error.message });
  const job_id = 'job_' + randomUUID();

  // Kick off lightweight background work (fire-and-forget)
  const upload = uploads.get(parse.data.upload_id);
  if (upload?.source_type === 'url' && upload.source_url) {
    (async () => {
      try {
        const { title, description } = await fetchYouTubePage(upload.source_url!);
        const transcriptText = await tryFetchYouTubeTranscript(upload.source_url!);
        const recipe = synthesizeRecipe({ title, description, transcriptText });
        const md = renderMarkdown(recipe);
        const txt = renderTxt(recipe);
        jobResults.set(job_id, { recipe_json: recipe, markdown: md, txt });
      } catch (_err) {
        jobResults.set(job_id, { recipe_json: fallbackRecipe('Failed to extract content'), markdown: '# Error', txt: 'Error' });
      }
    })();
  } else {
    jobResults.set(job_id, { recipe_json: fallbackRecipe('File processing not implemented'), markdown: '# Pending', txt: 'Pending' });
  }

  return res.json({ job_id, sse_url: `/api/jobs/${job_id}/events` });
});

router.get('/jobs/:job_id/status', (_req: Request, res: Response) => {
  return res.json({ state: 'synthesizing', progress: { pct: 72 } });
});

router.get('/jobs/:job_id/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const states = ['queued','extracting','transcribing','understanding','synthesizing','validating','completed'];
  let i = 0;
  const interval = setInterval(() => {
    if (i >= states.length) { clearInterval(interval); return; }
    res.write(`event: ${states[i]}\n`);
    res.write(`data: {\"state\":\"${states[i]}\"}\n\n`);
    i++;
    if (i === states.length) setTimeout(() => res.end(), 300);
  }, 600);
  req.on('close', () => clearInterval(interval));
});

router.get('/get-recipe', (req: Request, res: Response) => {
  const job_id = req.query.job_id as string | undefined;
  if (!job_id) return res.status(400).json({ error: 'invalid_request', message: 'job_id is required' });
  const result = jobResults.get(job_id);
  if (!result) return res.status(425).json({ error: 'not_ready', message: 'Job still processing, try again soon' });
  res.json(result);
});

router.get('/list-history', (_req: Request, res: Response) => {
  res.json({ items: [], next_cursor: null });
});

router.post('/submit-feedback', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

router.delete('/delete-assets', (_req: Request, res: Response) => {
  res.json({ status: 'scheduled' });
});

// --- Helpers (MVP-grade heuristics) ---
async function fetchYouTubePage(url: string): Promise<{ title: string; description: string }> {
  const resp = await fetch(url, { headers: { 'accept-language': 'en' } });
  const html = await resp.text();
  // Prefer ytInitialPlayerResponse JSON
  const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  const pr: any = prMatch && prMatch[1] ? safeJson(prMatch[1] as string) : null;
  let title: string = (pr as any)?.videoDetails?.title || '';
  let description: string = (pr as any)?.videoDetails?.shortDescription || '';
  // Fallbacks
  if (!title) title = html.match(/<meta\s+property=\"og:title\"\s+content=\"([^\"]+)\"/i)?.[1] ?? 'Recipe';
  if (!description) {
    const shortDescMatch = html.match(/\"shortDescription\":\"([\s\S]*?)\"\s*,\s*\"isCrawlable\"/);
    if (shortDescMatch?.[1]) {
      description = JSON.parse('\"' + shortDescMatch[1].replace(/\\n/g, '\n').replace(/\\\"/g, '\"') + '\"');
    }
  }
  return { title, description };
}

async function tryFetchYouTubeTranscript(url: string): Promise<string> {
  const idMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  const videoId = idMatch?.[1];
  if (!videoId) return '';
  // Try captions URLs from ytInitialPlayerResponse first (auto-captions or standard)
  try {
    const watchHtml = await (await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'accept-language': 'en' } })).text();
    const prMatch = watchHtml.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
    const pr: any = prMatch && prMatch[1] ? safeJson(prMatch[1] as string) : null;
    const tracks: Array<any> | undefined = (pr as any)?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(tracks) && tracks.length > 0) {
      const preferred = tracks.find(t => /^(en|en-)/i.test(t.languageCode)) || tracks.find(t => /^(es|es-)/i.test(t.languageCode)) || tracks[0];
      if (preferred?.baseUrl) {
        const vttUrl = preferred.baseUrl + (preferred.baseUrl.includes('?') ? '&' : '?') + 'fmt=vtt';
        const vttResp = await fetch(vttUrl);
        if (vttResp.ok) {
          const vtt = await vttResp.text();
          const merged = vttToPlainText(vtt);
          if (merged.trim()) return merged;
        }
        const xmlResp = await fetch(preferred.baseUrl);
        if (xmlResp.ok) {
          const xml = await xmlResp.text();
          const items = Array.from(xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)).map(m => decodeHtml(m[1] ?? ''));
          if (items.length > 0) return items.join(' ').replace(/\s+/g, ' ').trim();
        }
      }
    }
  } catch {}

  // Fallback to legacy timedtext endpoint with several languages
  const langs = ['en', 'en-US', 'en-GB', 'es', 'es-419'];
  for (const lang of langs) {
    try {
      const ttUrl = `https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(lang)}&v=${videoId}`;
      const r = await fetch(ttUrl);
      if (!r.ok) continue;
      const xml = await r.text();
      if (!xml.includes('<text')) continue;
      const items = Array.from(xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)).map(m => decodeHtml(m[1] ?? ''));
      if (items.length > 0) return items.join(' ').replace(/\s+/g, ' ').trim();
    } catch {}
  }
  return '';
}

function vttToPlainText(vtt: string): string {
  // Remove WEBVTT headers and timestamps, keep caption lines
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line || /^WEBVTT/i.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue;
    out.push(line.replace(/<[^>]+>/g, ''));
  }
  return out.join(' ');
}

function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '\"')
    .replace(/&#39;/g, "'");
}

function synthesizeRecipe(input: { title: string; description: string; transcriptText: string }) {
  const title = input.title || 'Recipe';
  const ingredients = extractIngredients(input.description);
  const steps = extractSteps(input.transcriptText || input.description);
  return {
    title,
    servings: 4,
    time: { total: '—', active: '—' },
    ingredients,
    equipment: [],
    steps: steps.map((t, idx) => ({ n: idx + 1, text: t })),
    notes: [],
    allergens: []
  };
}

function extractIngredients(description: string): Array<{ quantity: number | null; unit: string | null; item: string }> {
  const lines = (description || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  // Find a section starting with "Ingredients" (EN/ES) and collect following bullet-like lines
  const startIdx = lines.findIndex(l => /^ingredients\b|^ingredientes\b/i.test(l));
  const candidates = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;
  const items: Array<{ quantity: number | null; unit: string | null; item: string }> = [];
  for (const line of candidates) {
    if (/^\s*-{2,}\s*$/.test(line)) continue;
    if (/^\s*(instructions|method|directions)\b/i.test(line)) break;
    if (!/[a-zA-Z]/.test(line)) continue;
    // crude parse: quantity + unit + item
    const m = line.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Zµμ]+)?\s*(.+)$/);
    if (m) {
      items.push({ quantity: Number(m[1]), unit: m[2] || null, item: m[3] ?? '' });
    } else {
      // bullet or plain line
      items.push({ quantity: null, unit: null, item: line.replace(/^[\-•\*]\s*/, '') });
    }
    if (items.length >= 50) break;
  }
  return items;
}

function extractSteps(text: string): string[] {
  if (!text) return ['Review ingredients and steps from the video.'];
  // Split into sentences and keep those starting with verbs or containing cooking cues
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const cues = /(add|mix|stir|combine|cook|bake|boil|simmer|fry|heat|season|chop|slice|blend|pour|spread|press|marinate|assemble|serve)/i;
  const picked: string[] = [];
  for (const s of sentences) {
    if (cues.test(s)) picked.push(capitalize(s.replace(/^\d+[:\.)]\s*/, '')));
    if (picked.length >= 12) break;
  }
  if (picked.length === 0) picked.push(sentences[0] || 'Follow the video steps.');
  return picked.map((s) => s.replace(/^([a-z])/, (m) => m.toUpperCase()));
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function renderMarkdown(r: any): string {
  const ing = r.ingredients.map((i: any) => `- ${i.quantity ?? ''} ${i.unit ?? ''} ${i.item}`.trim()).join('\n');
  const steps = r.steps.map((s: any) => `${s.n}. ${s.text}`).join('\n');
  return `# ${r.title}\n\n**Servings:** ${r.servings}\n\n\n## Ingredients\n${ing}\n\n## Instructions\n${steps}\n`;
}

function renderTxt(r: any): string {
  const ing = r.ingredients.map((i: any) => `- ${i.quantity ?? ''} ${i.unit ?? ''} ${i.item}`.trim()).join('\n');
  const steps = r.steps.map((s: any) => `${s.n}. ${s.text}`).join('\n');
  return `${r.title}\nServings: ${r.servings}\n\nIngredients\n${ing}\n\nInstructions\n${steps}\n`;
}

function fallbackRecipe(message: string) {
  return {
    title: 'Recipe',
    servings: 2,
    time: { total: '—', active: '—' },
    ingredients: [],
    equipment: [],
    steps: [{ n: 1, text: message }],
    notes: [],
    allergens: []
  };
}
