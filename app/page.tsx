"use client";

import { FormEvent, useMemo, useState } from "react";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;

    const message = input.trim();
    setInput("");
    setError(null);
    setLoading(true);

    setMessages((prev) => [...prev, { role: "user", content: message }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });

      const contentType = response.headers.get("content-type") || "";
      let data: any = null;
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        const text = await response.text();
        if (!response.ok) {
          throw new Error(text || "Request failed");
        }
        throw new Error(text || "Unexpected response");
      }
      if (!response.ok) {
        throw new Error(data?.error ?? "Request failed");
      }

      if (data?.conversationId && !conversationId) {
        setConversationId(data.conversationId);
      }

      if (data?.reply) {
        setMessages((prev) => [...prev, { role: "agent", content: data.reply }]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 8 }}>Booking Assistant</h1>
      <p style={{ color: "#666", marginBottom: 24 }}>
        Ask for a service, date, and time. I will validate the booking and save it.
      </p>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 16,
          minHeight: 320,
          background: "#fafafa",
          marginBottom: 16,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: "#999" }}>Start by typing a booking request below.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {messages.map((msg, index) => (
              <li
                key={`${msg.role}-${index}`}
                style={{
                  marginBottom: 12,
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "80%",
                    padding: "10px 14px",
                    borderRadius: 12,
                    background: msg.role === "user" ? "#111827" : "#fff",
                    color: msg.role === "user" ? "#fff" : "#111827",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                    whiteSpace: "pre-line",
                  }}
                >
                  {msg.content}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 12 }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Try: I want a haircut on 2026-02-10 at 14:30"
          style={{
            flex: 1,
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid #d1d5db",
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          style={{
            padding: "12px 18px",
            borderRadius: 10,
            border: "none",
            background: canSend ? "#2563eb" : "#93c5fd",
            color: "#fff",
            fontWeight: 600,
            cursor: canSend ? "pointer" : "not-allowed",
          }}
        >
          {loading ? "Sending..." : "Send"}
        </button>
      </form>

      {error ? (
        <p style={{ marginTop: 12, color: "#dc2626" }}>Error: {error}</p>
      ) : null}
    </main>
  );
}

