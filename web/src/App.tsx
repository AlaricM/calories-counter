import { useEffect, useRef, useState } from "react";
import {
  AuthError,
  loadConfig,
  streamChat,
  toolLabel,
  type ChatMessage,
} from "./api";

type ToolActivity = { id: number; name: string; active: boolean };
type Pending = { text: string; tools: ToolActivity[] };

const EXAMPLES = [
  "I ate 6oz ribeye and a cup of white rice",
  "Add greek yogurt: 160 cal, 17g protein, 9g carbs",
  "How am I doing today?",
];

export default function App() {
  const [chatUrl, setChatUrl] = useState<string>(() => localStorage.getItem("chatUrl") ?? "");
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem("apiKey") ?? "");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the deploy-time config (chat URL). A value already in localStorage (e.g.
  // set for local dev) wins so you can point the dev server at a real backend.
  useEffect(() => {
    loadConfig().then((cfg) => {
      if (cfg.chatUrl && !localStorage.getItem("chatUrl")) setChatUrl(cfg.chatUrl);
      setConfigLoaded(true);
    });
  }, []);

  // First-run: open settings if we don't yet have both a URL and a key.
  useEffect(() => {
    if (configLoaded && (!chatUrl || !apiKey)) setShowSettings(true);
  }, [configLoaded, chatUrl, apiKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    if (!chatUrl || !apiKey) {
      setShowSettings(true);
      return;
    }

    setError(null);
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setBusy(true);

    let acc = "";
    const tools: ToolActivity[] = [];
    let toolId = 0;
    const snapshot = () => setPending({ text: acc, tools: tools.map((t) => ({ ...t })) });
    snapshot();

    try {
      for await (const ev of streamChat(chatUrl, apiKey, next)) {
        if (ev.type === "delta") {
          acc += ev.text;
          snapshot();
        } else if (ev.type === "tool") {
          if (ev.phase === "start") {
            tools.push({ id: toolId++, name: ev.name, active: true });
          } else {
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === ev.name && tools[i].active) {
                tools[i].active = false;
                break;
              }
            }
          }
          snapshot();
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      }
      if (acc.trim()) setMessages((m) => [...m, { role: "assistant", content: acc }]);
    } catch (err) {
      if (err instanceof AuthError) {
        setError(err.message);
        setShowSettings(true);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  const hasConversation = messages.length > 0 || pending !== null;

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-emerald-50/60 to-zinc-50 text-zinc-800">
      <Header onSettings={() => setShowSettings(true)} onReset={() => setMessages([])} />

      <main ref={scrollRef} className="scroll-slim mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4">
        {!hasConversation ? (
          <EmptyState onPick={(ex) => send(ex)} />
        ) : (
          <div className="flex flex-col gap-4 py-6">
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} />
            ))}
            {pending && <PendingBubble pending={pending} />}
          </div>
        )}
      </main>

      {error && (
        <div className="mx-auto w-full max-w-2xl px-4">
          <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        </div>
      )}

      <Composer
        value={input}
        busy={busy}
        onChange={setInput}
        onSend={() => send(input)}
      />

      {showSettings && (
        <SettingsModal
          chatUrl={chatUrl}
          apiKey={apiKey}
          onSave={(url, key) => {
            setChatUrl(url);
            setApiKey(key);
            localStorage.setItem("chatUrl", url);
            localStorage.setItem("apiKey", key);
            setShowSettings(false);
            setError(null);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function Header({ onSettings, onReset }: { onSettings: () => void; onReset: () => void }) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">🥗</span>
          <h1 className="text-sm font-semibold tracking-tight text-zinc-900">
            Calorie &amp; Macro Tracker
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onReset}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            title="New conversation"
          >
            New chat
          </button>
          <button
            onClick={onSettings}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            title="Settings"
          >
            ⚙︎ Settings
          </button>
        </div>
      </div>
    </header>
  );
}

function EmptyState({ onPick }: { onPick: (ex: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 py-16 text-center">
      <div>
        <div className="text-4xl">🥗</div>
        <h2 className="mt-3 text-lg font-semibold text-zinc-900">What did you eat?</h2>
        <p className="mt-1 max-w-sm text-sm text-zinc-500">
          Tell me in plain words. I'll look up nutrition facts, remember your foods, and keep your
          daily calories and macros on track.
        </p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => onPick(ex)}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm text-zinc-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-sm text-white shadow-sm"
            : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-800 shadow-sm"
        }
      >
        {content}
      </div>
    </div>
  );
}

function PendingBubble({ pending }: { pending: Pending }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-800 shadow-sm">
        {pending.tools.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {pending.tools.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-xs text-zinc-500">
                <span className={t.active ? "animate-pulse" : ""}>{t.active ? "◍" : "✓"}</span>
                <span>{toolLabel(t.name)}</span>
              </div>
            ))}
          </div>
        )}
        {pending.text ? (
          <span className="whitespace-pre-wrap">{pending.text}</span>
        ) : pending.tools.length === 0 ? (
          <TypingDots />
        ) : null}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 py-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
    </span>
  );
}

function Composer({
  value,
  busy,
  onChange,
  onSend,
}: {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="border-t border-zinc-200 bg-white/80 backdrop-blur">
      <div className="mx-auto w-full max-w-2xl px-4 py-3">
        <div className="flex items-end gap-2 rounded-2xl border border-zinc-300 bg-white px-3 py-2 shadow-sm focus-within:border-emerald-400">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder="What did you eat?"
            className="max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-400"
          />
          <button
            onClick={onSend}
            disabled={busy || !value.trim()}
            className="mb-0.5 shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-zinc-400">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}

function SettingsModal({
  chatUrl,
  apiKey,
  onSave,
  onClose,
}: {
  chatUrl: string;
  apiKey: string;
  onSave: (url: string, key: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(chatUrl);
  const [key, setKey] = useState(apiKey);
  const canSave = url.trim() && key.trim();

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-zinc-900">Connect your tracker</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Your API key is stored only in this browser and sent straight to your backend.
        </p>

        <label className="mt-4 block text-xs font-medium text-zinc-600">Backend URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…lambda-url.us-east-1.on.aws/"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-emerald-400"
        />

        <label className="mt-3 block text-xs font-medium text-zinc-600">API key</label>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          placeholder="your personal key"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-emerald-400"
        />

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={() => canSave && onSave(url.trim(), key.trim())}
            disabled={!canSave}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
