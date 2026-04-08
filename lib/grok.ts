// Minimal Grok (xAI) Responses API client.
// Docs: https://docs.x.ai/docs/api-reference#responses

const DEFAULT_BASE = 'https://api.x.ai/v1';

/**
 * xAI native X Search tool spec for the Responses API. Passing this in
 * `tools` lets Grok ground its answer in real-time X (Twitter) posts
 * instead of relying solely on its training data.
 *
 * Docs: https://docs.x.ai/developers/tools/x-search
 *
 * Note: web grounding is a separate tool — pass `{ type: 'web_search' }`
 * alongside this one if you also want web results. The old Chat
 * Completions `search_parameters` shape is deprecated.
 */
export interface XSearchTool {
  type: 'x_search';
  from_date?: string;                    // ISO date "YYYY-MM-DD"
  to_date?: string;                      // ISO date "YYYY-MM-DD"
  allowed_x_handles?: string[];          // max 10, mutually exclusive with excluded
  excluded_x_handles?: string[];         // max 10
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

export interface WebSearchTool {
  type: 'web_search';
  allowed_domains?: string[];            // max 5, mutually exclusive with excluded
  excluded_domains?: string[];           // max 5
  enable_image_understanding?: boolean;
}

export interface GrokResponsesRequest {
  model?: string;
  input: string;
  previous_response_id?: string;
  temperature?: number;
  tools?: Array<XSearchTool | WebSearchTool | Record<string, any>>;
}

export interface GrokResponsesResult {
  id: string;
  output_text: string;
  citations: string[];
  raw: unknown;
}

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw new Error('XAI_API_KEY is not set. Add it to .env.local');
  }
  return key;
}

function getBase(): string {
  return process.env.XAI_API_BASE || DEFAULT_BASE;
}

/**
 * Call the xAI Responses API. Returns the assistant's text output and the
 * response id so callers can plumb `previous_response_id` on the next turn.
 */
export async function callGrokResponses(
  req: GrokResponsesRequest,
): Promise<GrokResponsesResult> {
  const body: Record<string, unknown> = {
    model: req.model || process.env.GROK_MODEL || 'grok-4.20-reasoning',
    input: req.input,
    previous_response_id: req.previous_response_id,
    temperature: req.temperature ?? 0.2,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
  }

  const res = await fetch(`${getBase()}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Grok ${res.status}: ${text || res.statusText}`);
  }

  const data: any = await res.json();

  // The Responses API returns `output_text` as a convenience field on most
  // recent xAI builds; if absent, fall back to walking the `output` array.
  const outputText: string =
    data.output_text ??
    (Array.isArray(data.output)
      ? data.output
          .flatMap((o: any) => o?.content ?? [])
          .map((c: any) => c?.text ?? '')
          .join('')
      : '');

  // Citations come back as an array of URLs on the response. Walk a few
  // possible locations since xAI has shipped this under slightly different
  // shapes across SDK versions.
  const citations: string[] = Array.isArray(data.citations)
    ? data.citations
    : Array.isArray(data?.response?.citations)
      ? data.response.citations
      : [];

  return {
    id: data.id,
    output_text: outputText,
    citations,
    raw: data,
  };
}

/**
 * Convenience helper: build an x_search tool spec for the most recent N
 * days of X posts. Pass into GrokResponsesRequest.tools.
 */
export function recentXSearchTool(days = 1): XSearchTool {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - days);
  return {
    type: 'x_search',
    from_date: from.toISOString().slice(0, 10),
  };
}
