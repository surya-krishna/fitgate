/**
 * Provider chain: every provider speaks the OpenAI chat-completions dialect, so
 * one tiny client covers OpenRouter, Google Gemini (OpenAI-compatible endpoint)
 * and OpenAI. Order of preference is OpenRouter → Gemini → OpenAI; a provider
 * is skipped when its API key is missing, and the next one is tried when a
 * call fails (network, 5xx, 429, malformed JSON).
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ProviderName = "openrouter" | "gemini" | "openai";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra headers (OpenRouter likes HTTP-Referer / X-Title for rankings). */
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  providers: ProviderConfig[];
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Called on every failover for logging. */
  onFailover?: (provider: ProviderName, error: unknown) => void;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly attempts: { provider: ProviderName; error: string }[],
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Build the default chain from environment variables. Missing keys are skipped. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (env.OPENROUTER_API_KEY) {
    out.push({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
      headers: {
        "HTTP-Referer": env.FITGATE_PUBLIC_URL ?? "https://github.com/fitgate/fitgate",
        "X-Title": "FitGate",
      },
    });
  }
  if (env.GEMINI_API_KEY) {
    out.push({
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    });
  }
  if (env.OPENAI_API_KEY) {
    out.push({
      name: "openai",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
    });
  }
  return out;
}

export class LlmClient {
  private readonly providers: ProviderConfig[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onFailover?: LlmClientOptions["onFailover"];

  constructor(opts: LlmClientOptions) {
    this.providers = opts.providers;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.onFailover = opts.onFailover;
  }

  get available(): boolean {
    return this.providers.length > 0;
  }

  /** Plain text completion with failover. */
  async complete(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const res = await this.request(messages, { ...opts, schema: undefined });
    return res.text;
  }

  /**
   * Structured completion: asks for JSON matching `schema` (via response_format
   * json_schema where supported), validates with zod, and fails over on
   * validation errors too — a provider that can't follow the schema is as
   * useless as one that's down.
   */
  async completeJson<T extends z.ZodTypeAny>(
    messages: ChatMessage[],
    schema: T,
    opts: { temperature?: number; maxTokens?: number; schemaName?: string } = {},
  ): Promise<{ data: z.infer<T>; provider: ProviderName; model: string }> {
    const res = await this.request(messages, { ...opts, schema, schemaName: opts.schemaName ?? "response" });
    return { data: res.parsed as z.infer<T>, provider: res.provider, model: res.model };
  }

  private async request(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; schema?: z.ZodTypeAny; schemaName?: string },
  ): Promise<{ text: string; parsed?: unknown; provider: ProviderName; model: string }> {
    const attempts: { provider: ProviderName; error: string }[] = [];
    for (const p of this.providers) {
      try {
        const body: Record<string, unknown> = {
          model: p.model,
          messages,
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 4000,
        };
        if (opts.schema) {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: opts.schemaName,
              strict: true,
              schema: zodToJsonSchema(opts.schema, { target: "openAi" }),
            },
          };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let resp: Response;
        try {
          resp = await this.fetchImpl(`${p.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${p.apiKey}`,
              ...(p.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        }
        const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
        const text = json.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) throw new Error("empty completion");
        if (!opts.schema) return { text, provider: p.name, model: p.model };
        const parsed = opts.schema.safeParse(JSON.parse(stripFences(text)));
        if (!parsed.success) throw new Error(`schema validation failed: ${parsed.error.issues[0]?.message}`);
        return { text, parsed: parsed.data, provider: p.name, model: p.model };
      } catch (err) {
        attempts.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) });
        this.onFailover?.(p.name, err);
      }
    }
    throw new LlmError(
      attempts.length ? `All LLM providers failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}` : "No LLM providers configured",
      attempts,
    );
  }
}

/** Some models wrap JSON in ```json fences even when asked not to. */
export function stripFences(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m?.[1] ?? s.trim();
}
