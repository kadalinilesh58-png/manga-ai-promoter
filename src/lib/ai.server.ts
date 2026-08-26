const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function apiKey() {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured (missing API key).");
  return key;
}

export class AiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function friendly(status: number, message: string) {
  if (status === 429) return "AI is rate limited right now. Please retry in a moment.";
  if (status === 402) return message || "AI credits are exhausted. Add credits to continue.";
  if (status === 403) return message || "AI access is blocked for this workspace.";
  return message || `AI request failed (${status}).`;
}

export async function chat(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message ?? JSON.parse(text)?.message ?? text;
    } catch {
      /* keep raw */
    }
    throw new AiError(res.status, friendly(res.status, message));
  }
  const json = JSON.parse(text);
  return json?.choices?.[0]?.message?.content ?? "";
}

/** Ask for JSON and parse defensively (handles ```json fences). */
export async function chatJson<T>(body: Record<string, unknown>): Promise<T> {
  const raw = await chat(body);
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(candidate) as T;
}

/** Generates an image and returns raw base64 (no data: prefix). */
export async function generateImageBase64(prompt: string): Promise<string> {
  const res = await fetch(`${GATEWAY}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-image",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      modalities: ["image", "text"],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message ?? text;
    } catch {
      /* keep raw */
    }
    throw new AiError(res.status, friendly(res.status, message));
  }
  const json = JSON.parse(text);
  const b64 =
    json?.data?.[0]?.b64_json ??
    json?.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
    json?.data?.[0]?.url;
  if (!b64) throw new AiError(500, "The image model returned no image.");
  return String(b64).replace(/^data:image\/\w+;base64,/, "");
}
