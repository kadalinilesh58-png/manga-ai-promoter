import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { chatJson, generateImageBase64 } from "./ai.server";
import { getAccessToken, ytFetch } from "./youtube.server";

const MODEL = "google/gemini-3.7-flash";

export type StoryBrief = {
  seriesGuess: string;
  genres: string[];
  logline: string;
  keyCharacters: string[];
  hookMoment: string;
  moodPalette: string;
  seedQueries: string[];
  thumbnailPrompt: string;
  titleCandidates: string[];
};

export type CompetitorVideo = {
  title: string;
  channel: string;
  views: number;
  publishedAt: string;
  tags: string[];
  descriptionSnippet: string;
};

export type ResearchData = {
  queries: string[];
  suggestions: string[];
  competitors: CompetitorVideo[];
  topTagFrequency: { tag: string; count: number }[];
  titlePatterns: string[];
};

export type Metadata = {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  keywords: string[];
  strategyNotes: string[];
};

/* ------------------------------------------------------------------ */
/* Step 1 — read the story file                                        */
/* ------------------------------------------------------------------ */

export async function analyzeStory(storyText: string): Promise<StoryBrief> {
  const excerpt = storyText.slice(0, 60_000);
  return chatJson<StoryBrief>({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a manga/manhwa content strategist. Read the supplied story text and extract a structured brief. Reply with JSON only, no prose, no code fences.",
      },
      {
        role: "user",
        content: `Story text:\n\n${excerpt}\n\nReturn JSON with exactly these keys:
{
  "seriesGuess": "likely series/story name",
  "genres": ["3-6 genre labels"],
  "logline": "one punchy sentence",
  "keyCharacters": ["up to 5 names or descriptors"],
  "hookMoment": "the single most clickable moment in the story",
  "moodPalette": "colour + lighting mood in a few words",
  "seedQueries": ["6 YouTube search queries a fan of this story would actually type"],
  "thumbnailPrompt": "a vivid art-direction prompt for a 16:9 YouTube thumbnail: manhwa/manga webtoon illustration style, dramatic lighting, one hero character, high contrast, cinematic, no text overlays",
  "titleCandidates": ["5 clickable YouTube titles under 90 characters each"]
}`,
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Step 2 — live YouTube research                                      */
/* ------------------------------------------------------------------ */

async function autocomplete(query: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=us&q=${encodeURIComponent(query)}`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as [string, string[]];
    return Array.isArray(json?.[1]) ? json[1].slice(0, 10) : [];
  } catch {
    return [];
  }
}

export async function runResearch(brief: StoryBrief): Promise<ResearchData> {
  const { token } = await getAccessToken();

  const base = [
    ...brief.seedQueries.slice(0, 5),
    `${brief.seriesGuess} manhwa recap`,
    `${brief.genres[0] ?? "manhwa"} manhwa explained`,
  ].filter(Boolean);

  const suggestionLists = await Promise.all(base.slice(0, 6).map(autocomplete));
  const suggestions = Array.from(new Set(suggestionLists.flat())).slice(0, 60);

  const videoIds = new Set<string>();
  for (const q of base.slice(0, 5)) {
    try {
      const search = (await ytFetch(
        `search?part=snippet&type=video&maxResults=10&order=relevance&regionCode=US&relevanceLanguage=en&q=${encodeURIComponent(q)}`,
        token,
      )) as { items?: { id?: { videoId?: string } }[] };
      for (const item of search.items ?? []) {
        if (item.id?.videoId) videoIds.add(item.id.videoId);
      }
    } catch {
      /* one failed query should not kill research */
    }
  }

  const competitors: CompetitorVideo[] = [];
  const ids = Array.from(videoIds).slice(0, 50);
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    try {
      const details = (await ytFetch(
        `videos?part=snippet,statistics&id=${chunk.join(",")}`,
        token,
      )) as {
        items?: {
          snippet?: {
            title?: string;
            channelTitle?: string;
            publishedAt?: string;
            tags?: string[];
            description?: string;
          };
          statistics?: { viewCount?: string };
        }[];
      };
      for (const item of details.items ?? []) {
        competitors.push({
          title: item.snippet?.title ?? "",
          channel: item.snippet?.channelTitle ?? "",
          views: Number(item.statistics?.viewCount ?? 0),
          publishedAt: item.snippet?.publishedAt ?? "",
          tags: item.snippet?.tags ?? [],
          descriptionSnippet: (item.snippet?.description ?? "").slice(0, 300),
        });
      }
    } catch {
      /* ignore chunk failure */
    }
  }

  competitors.sort((a, b) => b.views - a.views);

  const freq = new Map<string, number>();
  for (const c of competitors) {
    for (const tag of c.tags) {
      const key = tag.toLowerCase().trim();
      if (!key) continue;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const topTagFrequency = Array.from(freq.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);

  return {
    queries: base,
    suggestions,
    competitors: competitors.slice(0, 25),
    topTagFrequency,
    titlePatterns: competitors.slice(0, 12).map((c) => c.title),
  };
}

/* ------------------------------------------------------------------ */
/* Step 3 — synthesise publish-ready metadata                          */
/* ------------------------------------------------------------------ */

function clampTags(tags: string[]) {
  const out: string[] = [];
  let budget = 480; // YouTube caps total tag length at ~500 chars
  for (const raw of tags) {
    const tag = raw.replace(/[<>"]/g, "").trim();
    if (!tag || tag.length > 60) continue;
    if (out.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    const cost = tag.length + 1;
    if (budget - cost < 0) break;
    budget -= cost;
    out.push(tag);
  }
  return out;
}

export async function buildMetadata(
  brief: StoryBrief,
  research: ResearchData,
): Promise<Metadata> {
  const meta = await chatJson<Metadata>({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a senior YouTube SEO strategist for manga/manhwa recap channels. You optimise for global (US-first, English) search intent using the supplied live research. Reply with JSON only, no prose, no code fences.",
      },
      {
        role: "user",
        content: `STORY BRIEF (use only for topic understanding and the title):
${JSON.stringify(brief, null, 2)}

LIVE YOUTUBE RESEARCH (use this for tags, keywords, hashtags and description):
Search queries used: ${research.queries.join(" | ")}
Autocomplete demand: ${research.suggestions.join(" | ")}
Top ranking titles: ${research.titlePatterns.join(" | ")}
Most used competitor tags: ${research.topTagFrequency.map((t) => `${t.tag}(${t.count})`).join(", ")}
Top competitors: ${research.competitors
          .slice(0, 12)
          .map((c) => `${c.title} — ${c.views} views`)
          .join(" | ")}

Rules:
- Title: max 90 characters, front-load the highest-demand keyword, add curiosity, no clickbait lies, no emoji spam (max 1).
- Description: 900-1500 characters. First 150 characters must repeat the primary keyword naturally. Include a short hook, a 4-6 line chapter/summary section, a "Keywords" line, then hashtags on the last line.
- tags: 25-35 entries mixing exact-match, long-tail, and competitor tags. Every tag under 60 characters.
- hashtags: 8-12 entries, each starting with # and no spaces.
- keywords: 15-25 primary/secondary search phrases you targeted.
- strategyNotes: 4-6 short bullets explaining the ranking play.

Return JSON with keys: title, description, tags, hashtags, keywords, strategyNotes.`,
      },
    ],
  });

  const hashtags = (meta.hashtags ?? [])
    .map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, ""))
    .slice(0, 12);

  return {
    title: (meta.title ?? brief.titleCandidates?.[0] ?? "Manhwa Recap").slice(0, 98),
    description: (meta.description ?? "").slice(0, 4900),
    tags: clampTags(meta.tags ?? []),
    hashtags,
    keywords: (meta.keywords ?? []).slice(0, 25),
    strategyNotes: (meta.strategyNotes ?? []).slice(0, 8),
  };
}

/* ------------------------------------------------------------------ */
/* Thumbnail                                                           */
/* ------------------------------------------------------------------ */

export async function makeThumbnail(jobId: string, prompt: string) {
  const fullPrompt = `${prompt}

Format: 16:9 YouTube thumbnail, 1280x720, webtoon / manhwa digital illustration, bold rim lighting, saturated cinematic colour grade, strong focal character with an intense expression, dynamic background energy, high contrast so it pops at small sizes. Absolutely no text, no letters, no watermarks, no logos.`;
  const b64 = await generateImageBase64(fullPrompt);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const path = `${jobId}/${Date.now()}.png`;
  const { error } = await supabaseAdmin.storage
    .from("thumbnails")
    .upload(path, bytes, { contentType: "image/png", upsert: true });
  if (error) throw new Error(error.message);
  return path;
}

export async function signThumbnail(path: string | null) {
  if (!path) return null;
  const { data } = await supabaseAdmin.storage.from("thumbnails").createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

/* ------------------------------------------------------------------ */
/* Upload + publish                                                    */
/* ------------------------------------------------------------------ */

export async function startResumableUpload(input: {
  jobId: string;
  fileSize: number;
  mimeType: string;
}) {
  const { token } = await getAccessToken();
  const { data: job, error } = await supabaseAdmin
    .from("video_jobs")
    .select("*")
    .eq("id", input.jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!job) throw new Error("Job not found.");
  if (!job.title) throw new Error("Generate the metadata before uploading.");

  const body = {
    snippet: {
      title: String(job.title).slice(0, 98),
      description: String(job.description ?? "").slice(0, 4900),
      tags: (job.tags ?? []) as string[],
      categoryId: "1",
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false,
      embeddable: true,
      license: "youtube",
    },
  };

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.fileSize),
        "X-Upload-Content-Type": input.mimeType || "video/*",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not start the YouTube upload: ${text.slice(0, 300)}`);
  }
  const uploadUrl = res.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return an upload session URL.");

  await supabaseAdmin
    .from("video_jobs")
    .update({ status: "uploading", error: null, updated_at: new Date().toISOString() })
    .eq("id", input.jobId);

  return { uploadUrl };
}

export async function finalizeUpload(jobId: string, videoId: string) {
  const { token, channel } = await getAccessToken();
  const { data: job } = await supabaseAdmin
    .from("video_jobs")
    .select("thumbnail_path")
    .eq("id", jobId)
    .maybeSingle();

  let thumbnailApplied = false;
  const path = job?.thumbnail_path as string | null | undefined;
  if (path) {
    const { data: file } = await supabaseAdmin.storage.from("thumbnails").download(path);
    if (file) {
      const buf = await file.arrayBuffer();
      const res = await fetch(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "image/png" },
          body: buf,
        },
      );
      thumbnailApplied = res.ok;
    }
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from("video_jobs")
    .update({
      status: "published",
      youtube_video_id: videoId,
      channel_id: channel.channel_id,
      published_at: now,
      updated_at: now,
    })
    .eq("id", jobId);

  return { videoId, thumbnailApplied, url: `https://www.youtube.com/watch?v=${videoId}` };
}

/* ------------------------------------------------------------------ */
/* Post-publish verification                                           */
/* ------------------------------------------------------------------ */

export type Verification = {
  ok: boolean;
  videoId: string;
  uploadStatus: string | null;
  privacyStatus: string | null;
  processingStatus: string | null;
  rejectionReason: string | null;
  failureReason: string | null;
  title: string | null;
  thumbnailApplied: boolean;
  problems: string[];
  checkedAt: string;
};

/** Reads the video back from YouTube and confirms it really is live and playable. */
export async function verifyPublish(jobId: string, videoId: string): Promise<Verification> {
  const { token } = await getAccessToken();
  const res = await ytFetch(
    `videos?part=status,processingDetails,snippet,contentDetails&id=${videoId}`,
    token,
  );
  const item = (res as { items?: Array<Record<string, any>> })?.items?.[0];
  const problems: string[] = [];

  if (!item) {
    const verification: Verification = {
      ok: false,
      videoId,
      uploadStatus: null,
      privacyStatus: null,
      processingStatus: null,
      rejectionReason: null,
      failureReason: null,
      title: null,
      thumbnailApplied: false,
      problems: ["YouTube did not return this video yet. Give it a moment and re-check."],
      checkedAt: new Date().toISOString(),
    };
    await saveVerification(jobId, verification);
    return verification;
  }

  const status = item['status'] ?? {};
  const processing = item['processingDetails'] ?? {};
  const snippet = item['snippet'] ?? {};

  const uploadStatus: string | null = status.uploadStatus ?? null;
  const processingStatus: string | null = processing.processingStatus ?? null;

  if (uploadStatus === "rejected") {
    problems.push(`YouTube rejected the video (${status.rejectionReason ?? "unknown reason"}).`);
  }
  if (uploadStatus === "failed") {
    problems.push(`Upload failed (${status.failureReason ?? "unknown reason"}).`);
  }
  if (uploadStatus === "uploaded" || processingStatus === "processing") {
    problems.push("YouTube is still processing the video — re-check in a few minutes.");
  }
  if (processingStatus === "failed") {
    problems.push("YouTube could not process the file (parse/transcode failure).");
  }
  const thumbnailApplied = Boolean(
    snippet.thumbnails?.maxres || snippet.thumbnails?.standard || snippet.thumbnails?.high,
  );

  const verification: Verification = {
    ok: uploadStatus === "processed" && processingStatus !== "failed" && problems.length === 0,
    videoId,
    uploadStatus,
    privacyStatus: status.privacyStatus ?? null,
    processingStatus,
    rejectionReason: status.rejectionReason ?? null,
    failureReason: status.failureReason ?? null,
    title: snippet.title ?? null,
    thumbnailApplied,
    problems,
    checkedAt: new Date().toISOString(),
  };

  await saveVerification(jobId, verification);
  return verification;
}

async function saveVerification(jobId: string, verification: Verification) {
  await supabaseAdmin
    .from("video_jobs")
    .update({
      verification: JSON.parse(JSON.stringify(verification)) as Json,
      verified_at: verification.checkedAt,
      status: verification.ok ? "verified" : "published",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/* ------------------------------------------------------------------ */
/* Server-side cleanup — 1 hour after publish                          */
/* ------------------------------------------------------------------ */

/**
 * Deletes every server-side artifact for videos published more than one hour
 * ago: the generated thumbnail file in storage and the story-derived working
 * data. The YouTube video itself is never touched.
 */
export async function purgeExpiredArtifacts(olderThanMinutes = 60) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .select("id, thumbnail_path, youtube_video_id")
    .not("published_at", "is", null)
    .lte("published_at", cutoff)
    .is("purged_at", null);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { id: string; thumbnail_path: string | null }[];
  const paths = rows.map((r) => r.thumbnail_path).filter((p): p is string => Boolean(p));
  if (paths.length) {
    await supabaseAdmin.storage.from("thumbnails").remove(paths);
  }

  const now = new Date().toISOString();
  for (const row of rows) {
    await supabaseAdmin
      .from("video_jobs")
      .update({
        thumbnail_path: null,
        research: null,
        status: "archived",
        purged_at: now,
        updated_at: now,
      })
      .eq("id", row.id);
  }

  return { purged: rows.length, thumbnailsDeleted: paths.length, cutoff };
}
