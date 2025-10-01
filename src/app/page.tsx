"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react"; // ⬅️ add useEffect

type ChatRole = "user" | "assistant";
type ChatMsg = { role: ChatRole; content: string; ts: number };

type ChatAPIResponse = {
  answer?: string;
  used?: string[];
  narrowedCount?: number;
  error?: string;
};

type SuggestionAPIResponse = { suggestions: string[]; error?: string };

function formatTS(ts: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

export default function Home() {
  const [input, setInput] = useState<string>("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        'Welcome to SafeIntel AI. Ask about food-safety checks, e.g. “Opening Check for restaurant 74 on 15/08/2025?”',
      ts: Date.now(),
    },
  ]);
  const [loading, setLoading] = useState<boolean>(false);

  // ❯❯ suggestion chips shown only when a query fails
  const [chips, setChips] = useState<string[]>([]);

  // ❯❯ always-visible examples
  const [examples, setExamples] = useState<string[]>([]);

  // Fetch 7 good examples on first load (prefer Fridge AM/PM, Opening, Closing)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preferredTypes: [
              "Opening_Check",
              "Closing_Check",
              "Fridge_AM",
              "Fridge_PM",
              "Cooking",
              "Hot_Holding",
              "Cold_Holding",
            ],
            limit: 7,
          }),
        });
        const data = (await res.json()) as SuggestionAPIResponse;
        setExamples(data.suggestions ?? []);
      } catch {
        setExamples([]);
      }
    })();
  }, []);


  async function fetchSuggestions(lastUserText: string) {
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastUserText }),
      });
      const data = (await res.json()) as SuggestionAPIResponse;
      setChips(data.suggestions ?? []);
    } catch {
      setChips([]);
    }
  }

  async function send(prompt?: string) {
    const text = (prompt ?? input).trim();
    if (!text) return;

    const now = Date.now();
    setMsgs((m) => [...m, { role: "user", content: text, ts: now }]);
    setInput("");
    setLoading(true);
    setChips([]); // clear any failure chips

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...msgs, { role: "user", content: text, ts: now }].map((x) => ({
            role: x.role,
            content: x.content,
          })),
        }),
      });

      const data = (await res.json()) as ChatAPIResponse;
      const reply =
        data.answer ??
        (data.error ? `Error: ${data.error}` : "Sorry, no answer.");

      setMsgs((m) => [
        ...m,
        { role: "assistant", content: reply, ts: Date.now() },
      ]);

      // If we likely had no match, surface “did you mean” chips
      const noContext = !data.used || data.used.length === 0 || /i don’t have that record/i.test(reply);
      if (noContext) {
        void fetchSuggestions(text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: `Error: ${message}`, ts: Date.now() },
      ]);
      void fetchSuggestions(input);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="si-page">
      {/* Sticky header */}
      <header className="si-header">
        <Link href="/" aria-label="SafeIntel AI home">
          <Image
            className="si-header__logo"
            src="/safeintel-logo.png"
            alt="SafeIntel AI"
            width={1024}
            height={268}
            priority
          />
        </Link>
        <div className="si-header__title">SafeIntel AI</div>
      </header>

      {/* Main */}
      <main className="si-main">
        <div className="si-chat" role="log" aria-live="polite">
          {msgs.map((m, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column" }}>
              <div
                className={`si-bubble ${
                  m.role === "user" ? "si-bubble--user" : "si-bubble--assistant"
                }`}
              >
                {m.content}
              </div>
              <div
                className={`si-meta ${
                  m.role === "user" ? "si-meta--user" : "si-meta--assistant"
                }`}
              >
                {formatTS(m.ts)}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div className="si-bubble si-bubble--assistant">Thinking…</div>
              <div className="si-meta si-meta--assistant">{formatTS(Date.now())}</div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="si-composer">
          <input
            className="si-input"
            placeholder='Try: "Fridge PM for restaurant 74 on 15/08/2025?"'
            value={input}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setInput(e.target.value)
            }
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") void send();
            }}
            aria-label="Ask a question"
          />
          <button
            className="si-button"
            onClick={() => void send()}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>

        {/* Always-visible Examples (under the input) */}
        {examples.length > 0 && (
          <div className="si-section">
            <div className="si-section-title">Examples</div>
            <div className="si-chips" role="navigation" aria-label="Examples">
              {examples.map((c, idx) => (
                <button
                  key={`ex-${idx}`}
                  className="si-chip"
                  onClick={() => void send(c)}
                  title={c}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Failure suggestions (only when a query misses) */}
        {chips.length > 0 && (
          <div className="si-section">
            <div className="si-section-title">Did you mean</div>
            <div className="si-chips" role="navigation" aria-label="Suggestions">
              {chips.map((c, idx) => (
                <button
                  key={`sg-${idx}`}
                  className="si-chip"
                  onClick={() => void send(c)}
                  title={c}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="si-hint">Answers come strictly from your CSV-derived data.</p>
      </main>
    </div>
  );
}
