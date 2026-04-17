interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMOptions {
  messages: LLMMessage[];
  maxTokens?: number;
  model?: string;
}

interface LLMResponse {
  choices: { message: { content: string | null } }[];
}

export async function invokeLLM({ messages, maxTokens = 1024, model = "llama-3.3-70b-versatile" }: LLMOptions): Promise<LLMResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("[LLM] GROQ_API_KEY not set — skipping LLM call");
    return { choices: [{ message: { content: "AI desactivada: configura GROQ_API_KEY en .env" } }] };
  }

  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[LLM] Groq error ${resp.status}: ${err}`);
      return { choices: [{ message: { content: `Error IA: ${resp.status}` } }] };
    }

    const data = await resp.json() as LLMResponse;
    console.log(`[LLM] Groq response: ${(data.choices[0]?.message?.content || "").slice(0, 80)}...`);
    return data;
  } catch (e: any) {
    console.error(`[LLM] Groq fetch error: ${e.message}`);
    return { choices: [{ message: { content: "Error conectando con IA" } }] };
  }
}
