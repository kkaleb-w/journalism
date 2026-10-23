import type { Config, ProviderKind } from "./types.js";
import { loadState, saveState } from "./config.js";
import { fetchJson, sleep } from "./util.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  model?: string;
};

export type Usage = { input: number; output: number };

const sleepMs = (n: number) => sleep(n);

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(usage: Usage): void {
  const state = loadState();
  if (state.tokenDay !== today()) {
    state.tokenDay = today();
    state.tokensUsedToday = 0;
  }
  state.tokensUsedToday += usage.input + usage.output;
  saveState(state);
}

export function tokensLeftToday(budget: number): number {
  const state = loadState();
  if (state.tokenDay !== today()) return budget;
  return Math.max(0, budget - state.tokensUsedToday);
}

type OpenAIChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  content?: { type: string; text?: string }[];
  message?: { content?: { type: string; text?: string }[] };
  usage_metadata?: { prompt_token_count?: number; candidates_token_count?: number };
};

function normalizeUsage(raw: OpenAIChatResponse): Usage {
  return {
    input: raw.usage?.prompt_tokens ?? raw.usage?.input_tokens ?? raw.usage_metadata?.prompt_token_count ?? 0,
    output:
      raw.usage?.completion_tokens ??
      raw.usage?.output_tokens ??
      raw.usage_metadata?.candidates_token_count ??
      0,
  };
}

export async function chat(
  provider: Pick<Config["provider"], "kind" | "baseUrl" | "apiKey" | "model">,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ text: string; usage: Usage }> {
  const model = opts.model ?? provider.model;
  const maxTokens = opts.maxTokens ?? 2000;
  const kind = provider.kind as ProviderKind;
  let url = "";
  let body: unknown;
  let headers: Record<string, string> = { "content-type": "application/json" };

  if (kind === "anthropic") {
    url = `${trimSlash(provider.baseUrl)}/messages`;
    headers = {
      ...headers,
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    body = {
      model,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.1,
      system,
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    };
  } else if (kind === "gemini") {
    url = `${trimSlash(provider.baseUrl)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: {
        temperature: opts.temperature ?? 0.1,
        maxOutputTokens: maxTokens,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    };
  } else if (kind === "cohere") {
    url = `${trimSlash(provider.baseUrl)}/chat`;
    headers = { ...headers, authorization: `Bearer ${provider.apiKey}` };
    body = {
      model,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: m.content,
      })),
      temperature: opts.temperature ?? 0.1,
      max_tokens: maxTokens,
    };
  } else {
    url = `${trimSlash(provider.baseUrl)}/chat/completions`;
    headers = { ...headers, authorization: `Bearer ${provider.apiKey}` };
    body = {
      model,
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: maxTokens,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    };
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await fetchJson<OpenAIChatResponse>(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: false,
        timeoutMs: 120_000,
        retries: 0,
      });
      const text =
        raw.choices?.[0]?.message?.content ??
        raw.message?.content?.map((c) => c.text ?? "").join("") ??
        raw.content?.map((c) => c.text ?? "").join("") ??
        "";
      if (!text) throw new Error("Empty model response");
      const usage = normalizeUsage(raw);
      recordUsage(usage);
      return { text, usage };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 4(00|01|03|04)/.test(msg)) break;
      await sleepMs(1200 * (attempt + 1));
    }
  }
  throw new Error(`Model call failed (${provider.kind}/${model}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function listModels(provider: {
  kind: ProviderKind | string;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  try {
    if (provider.kind === "anthropic") {
      const data = await fetchJson<{ data?: { id: string }[] }>(`${trimSlash(provider.baseUrl)}/models?limit=100`, {
        headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
        cache: false,
      });
      return (data.data ?? []).map((m) => m.id);
    }
    if (provider.kind === "gemini") {
      const data = await fetchJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
        `${trimSlash(provider.baseUrl)}/models?key=${encodeURIComponent(provider.apiKey)}&pageSize=200`,
        { cache: false },
      );
      return (data.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""));
    }
    if (provider.kind === "cohere") {
      const data = await fetchJson<{ models?: { name: string }[] }>(`${trimSlash(provider.baseUrl)}/models?page_size=100`, {
        headers: { authorization: `Bearer ${provider.apiKey}` },
        cache: false,
      });
      return (data.models ?? []).map((m) => m.name);
    }
    const data = await fetchJson<{ data?: { id: string }[] }>(`${trimSlash(provider.baseUrl)}/models`, {
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      cache: false,
    });
    return (data.data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
