// src/app/page.tsx
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

type ChatRole = "user" | "assistant";
type ChatMsg = { role: ChatRole; content: string; ts: number };

type ChatAPIResponse = {
  answer?: string;
  used?: string[];
  narrowedCount?: number;
  error?: string;
};

type SuggestionAPIResponse = { suggestions: string[]; error?: string };

// --- formatting for the timestamps under bubbles ---
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

/* =======================
   LIGHT ANALYTICS HELPERS
   ======================= */

// Parse restaurant key (anonymous)
function parseRid(s: string): string | undefined {
  return s.match(/\b(restaurant|site|key)\s*#?\s*(\d+)\b/i)?.[2];
}

// Parse date to ISO (YYYY-MM-DD) for analytics only (no chrono here)
function parseIso(s: string): string | undefined {
  const uk = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (uk) {
    const dd = uk[1].padStart(2, "0");
    const mm = uk[2].padStart(2, "0");
    return `${uk[3]}-${mm}-${dd}`;
  }
  const iso = s.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  return iso ? iso[0] : undefined;
}

// Light check-type detection (anonymous)
function detectTypeLite(s: string): string | undefined {
  const msg = s.toLowerCase();
  if (/(fridge|frdge|friedge)/.test(msg)) {
    if (/\bpm\b/.test(msg)) return "Fridge_PM";
    if (/\bam\b/.test(msg)) return "Fridge_AM";
  }
  if (msg.includes("opening")) return "Opening_Check";
  if (msg.includes("closing")) return "Closing_Check";
  if (msg.includes("cooking")) return "Cooking";
  if (msg.includes("hot holding")) return "Hot_Holding";
  if (msg.includes("cold holding")) return "Cold_Holding";
  if (msg.includes("weekly cleaning")) return "Weekly_Cleaning";
  if (msg.includes("daily cleaning")) return "Daily_Cleaning";
  if (msg.includes("monthly cleaning")) return "Monthly_Cleaning";
  if (msg.includes("re-heating") || msg.includes("reheating")) return "Re-heating";
  if (msg.includes("cooling")) return "Cooling_of_Hot_Food";
  if (msg.includes("defrosting")) return "Defrosting";
  if (msg.includes("adhoc cleaning")) return "Adhoc_Cleaning";
  return undefined;
}

// Fire-and-forget tracker
async function track(
  kind: "pageview" | "qa" | "chip_click",
  meta: Record<string, unknown> = {}
) {
  try {
    await fetch("/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pathname":
          typeof window !== "undefined" ? window.location.pathname : "",
      },
      body: JSON.stringify({ kind, meta, ts: Date.now() }),
      keepalive: true,
    });
  } catch {
    // swallow
  }
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

  // chips shown when a query fails
  const [chips, setChips] = useState<string[]>([]);

  // always-visible examples
  const [examples, setExamples] = useState<string[]>([]);

  // Page view
  useEffect(() => {
    void track("pageview", {});
  }, []);

  // Fetch 7 good examples on first load (prefer a diverse set)
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

    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    const now = Date.now();
    setMsgs((m) => [...m, { role: "user", content: text, ts: now }]);
    setInput("");
    setLoading(true);
    setChips([]); // clear any previous failure chips

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...msgs, { role: "user", content: text, ts: now }].map(
            (x) => ({ role: x.role, content: x.content })
          ),
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

      // analytics
      const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const matched = Array.isArray(data.used) && data.used.length > 0;
      void track("qa", {
        latency_ms: Math.round((t1 as number) - (t0 as number)),
        matched,
        used_count: (data.used ?? []).length,
        type: detectTypeLite(text),
        restaurant_key: parseRid(text),
        date_iso: parseIso(text),
      });

      // If likely no match, show “Did you mean” chips
      const noContext =
        !data.used ||
        data.used.length === 0 ||
        /i don['’]t have that record/i.test(reply);
      if (noContext) {
        void fetchSuggestions(text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: `Error: ${message}`, ts: Date.now() },
      ]);

      // track failed QA
      void track("qa", {
        latency_ms: 0,
        matched: false,
        used_count: 0,
        type: detectTypeLite(text),
        restaurant_key: parseRid(text),
        date_iso: parseIso(text),
        error: "client_fetch_error",
      });

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
              <div className="si-meta si-meta--assistant">
                {formatTS(Date.now())}
              </div>
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

        {/* Always-visible Examples */}
        {examples.length > 0 && (
          <div className="si-section">
            <div className="si-section-title">Examples</div>
            <div className="si-chips" role="navigation" aria-label="Examples">
              {examples.map((c, idx) => (
                <button
                  key={`ex-${idx}`}
                  className="si-chip"
                  onClick={() => {
                    void track("chip_click", { source: "example", prompt: c });
                    void send(c);
                  }}
                  title={c}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Failure suggestions */}
        {chips.length > 0 && (
          <div className="si-section">
            <div className="si-section-title">Did you mean</div>
            <div className="si-chips" role="navigation" aria-label="Suggestions">
              {chips.map((c, idx) => (
                <button
                  key={`sg-${idx}`}
                  className="si-chip"
                  onClick={() => {
                    void track("chip_click", { source: "suggestion", prompt: c });
                    void send(c);
                  }}
                  title={c}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="si-hint">
          Answers come strictly from your CSV-derived data.
        </p>
      </main>
    </div>
  );
}
