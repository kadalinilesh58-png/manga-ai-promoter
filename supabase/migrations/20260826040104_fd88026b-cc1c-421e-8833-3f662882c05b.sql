
CREATE TABLE public.youtube_channels (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  channel_title TEXT NOT NULL,
  thumbnail_url TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.youtube_channels TO service_role;
ALTER TABLE public.youtube_channels ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.video_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id TEXT,
  file_name TEXT,
  file_size BIGINT,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT,
  description TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  thumbnail_path TEXT,
  thumbnail_prompt TEXT,
  research JSONB,
  youtube_video_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.video_jobs TO anon, authenticated;
GRANT ALL ON public.video_jobs TO service_role;
ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "video_jobs_read" ON public.video_jobs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "video_jobs_insert" ON public.video_jobs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "video_jobs_update" ON public.video_jobs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "video_jobs_delete" ON public.video_jobs FOR DELETE TO anon, authenticated USING (true);
