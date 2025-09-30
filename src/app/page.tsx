"use client";
import { useState } from "react";

type ChatRole = "user" | "assistant";
type ChatMsg = { role: ChatRole; content: string };

type ChatAPIResponse = {
  answer?: string;
  used?: string[];
  narrowedCount?: number;
  error?: string;
};

export default function Home() {
  const [input, setInput] = useState<string>("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        'Hi! Ask me about food-safety checks (e.g. “Opening Check for restaurant 74 on 29/09/2025?”)',
    },
  ]);
  const [loading, setLoading] = useState<boolean>(false);

  async function send() {
    const text = input.trim();
    if (!text) return;

    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...msgs, { role: "user", content: text }],
        }),
      });

      const data = (await res.json()) as ChatAPIResponse;
      const reply =
        data.answer ??
        (data.error ? `Error: ${data.error}` : "Sorry, no answer.");

      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: `Error: ${message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen max-w-2xl mx-auto p-6 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Safety Checks Assistant</h1>

      <div className="flex-1 flex flex-col gap-3 overflow-y-auto border rounded p-3">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block px-3 py-2 rounded-2xl ${
                m.role === "user" ? "bg-gray-200" : "bg-gray-100"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div className="text-sm opacity-60">Thinking…</div>}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder='Ask: "Fridge PM for The Picture Drome on 29/09/2025?"'
          value={input}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setInput(e.target.value)
          }
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button className="border rounded px-4 py-2" onClick={() => void send()}>
          Send
        </button>
      </div>

      <p className="text-xs opacity-70">
        Answers come strictly from your CSV-derived data.
      </p>
    </main>
  );
}
