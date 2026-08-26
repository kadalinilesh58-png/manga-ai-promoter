import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signThumbnail } from "./pipeline.server";
import type { Metadata, ResearchData, StoryBrief } from "./pipeline.server";

export type ResearchSummary = {
  brief?: StoryBrief;
  strategyNotes?: string[];
  queries?: string[];
  suggestions?: string[];
  topTags?: { tag: string; count: number }[];
  competitors?: { title: string; channel: string; views: number }[];
};

export type JobView = {
  id: string;
  status: string;
  fileName: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  hashtags: string[];
  keywords: string[];
  thumbnailUrl: string | null;
  thumbnailPrompt: string | null;
  youtubeVideoId: string | null;
  research: ResearchSummary | null;
  createdAt: string;
};

type Row = {
  id: string;
  status: string;
  file_name: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  hashtags: string[] | null;
  keywords: string[] | null;
  thumbnail_path: string | null;
  thumbnail_prompt: string | null;
  youtube_video_id: string | null;
  research: ResearchSummary | null;
  created_at: string;
};

async function toView(row: Row): Promise<JobView> {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    hashtags: row.hashtags ?? [],
    keywords: row.keywords ?? [],
    thumbnailUrl: await signThumbnail(row.thumbnail_path),
    thumbnailPrompt: row.thumbnail_prompt,
    youtubeVideoId: row.youtube_video_id,
    research: (row.research ?? null) as ResearchSummary | null,
    createdAt: row.created_at,
  };
}

export async function persistDraft(input: {
  fileName: string | null;
  fileSize: number | null;
  meta: Metadata;
  brief: StoryBrief;
  research: ResearchData;
}): Promise<JobView> {
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .insert({
      file_name: input.fileName,
      file_size: input.fileSize,
      status: "ready",
      title: input.meta.title,
      description: input.meta.description,
      tags: input.meta.tags,
      hashtags: input.meta.hashtags,
      keywords: input.meta.keywords,
      thumbnail_prompt: input.brief.thumbnailPrompt,
      research: {
        brief: input.brief,
        strategyNotes: input.meta.strategyNotes,
        queries: input.research.queries,
        suggestions: input.research.suggestions.slice(0, 40),
        topTags: input.research.topTagFrequency.slice(0, 30),
        competitors: input.research.competitors.slice(0, 12),
      },
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return toView(data as Row);
}

export async function saveThumbnailPath(jobId: string, path: string, prompt: string) {
  const { error } = await supabaseAdmin
    .from("video_jobs")
    .update({ thumbnail_path: path, thumbnail_prompt: prompt, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(error.message);
}

export async function loadJob(jobId: string): Promise<JobView | null> {
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toView(data as Row) : null;
}

export async function listJobs(): Promise<JobView[]> {
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return Promise.all(((data ?? []) as Row[]).map(toView));
}

export async function removeChannel() {
  const { error } = await supabaseAdmin.from("youtube_channels").delete().neq("channel_id", "");
  if (error) throw new Error(error.message);
}
