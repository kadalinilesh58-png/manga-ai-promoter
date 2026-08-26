import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");


export function googleClient() {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials are not configured.");
  }
  return { clientId, clientSecret };
}

export function redirectUriFor(origin: string) {
  return `${origin.replace(/\/$/, "")}/api/public/oauth/youtube/callback`;
}

export function buildAuthUrl(origin: string, state: string) {
  const { clientId } = googleClient();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(origin),
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
};

export async function exchangeCode(code: string, origin: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUriFor(origin),
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(json.error_description || json.error || "Token exchange failed");
  return json;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok) throw new Error(json.error_description || json.error || "Token refresh failed");
  return json;
}

export type ChannelRow = {
  channel_id: string;
  channel_title: string;
  thumbnail_url: string | null;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
};

export async function getChannelRow(): Promise<ChannelRow | null> {
  const { data, error } = await supabaseAdmin
    .from("youtube_channels")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelRow | null) ?? null;
}

/** Returns a valid access token, refreshing it when it is close to expiry. */
export async function getAccessToken(): Promise<{ token: string; channel: ChannelRow }> {
  const channel = await getChannelRow();
  if (!channel) throw new Error("No YouTube channel connected yet.");

  const expiresAt = new Date(channel.token_expires_at).getTime();
  if (expiresAt - Date.now() > 120_000) {
    return { token: channel.access_token, channel };
  }

  const refreshed = await refreshAccessToken(channel.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await supabaseAdmin
    .from("youtube_channels")
    .update({
      access_token: refreshed.access_token,
      token_expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq("channel_id", channel.channel_id);

  return {
    token: refreshed.access_token,
    channel: { ...channel, access_token: refreshed.access_token, token_expires_at: newExpiry },
  };
}

export async function ytFetch(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } })?.error?.message ?? `YouTube API error ${res.status}`;
    throw new Error(message);
  }
  return json as Record<string, unknown>;
}
