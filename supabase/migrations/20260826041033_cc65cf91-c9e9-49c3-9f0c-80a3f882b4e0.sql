ALTER TABLE public.video_jobs
  ADD COLUMN IF NOT EXISTS verification jsonb,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

CREATE INDEX IF NOT EXISTS video_jobs_purge_idx
  ON public.video_jobs (published_at)
  WHERE purged_at IS NULL;