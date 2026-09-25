"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

// The MCP server is mounted at /api/mcp by app/api/mcp/route.ts. The endpoint
// is derived from the browser's own origin so the panel is correct whether the
// dashboard runs on localhost:3000 or behind a real hostname.
const MCP_PATH = "/api/mcp";
const SSR_ORIGIN = "http://localhost:3000";
const COPIED_MS = 1600;
const FOCUSABLE =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STATUS_LABEL = {
  copied: "skopiowano",
  idle: "kopiuj",
  selected: "zaznaczone — Ctrl+C",
} as const;

/** Config-file clients. Claude Desktop still needs the `mcp-remote` stdio
 *  bridge for a plain HTTP server; the rest speak streamable HTTP natively,
 *  each under its own key. */
interface Provider {
  readonly config: (endpoint: string) => string;
  readonly file: string;
  readonly id: string;
  readonly label: string;
}

const PROVIDERS: readonly Provider[] = [
  {
    config: (endpoint) => `{
  "mcpServers": {
    "dietlownik": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpoint}"]
    }
  }
}`,
    file: "claude_desktop_config.json",
    id: "claude-desktop",
    label: "Claude Desktop",
  },
  {
    config: (endpoint) => `{
  "mcpServers": {
    "dietlownik": { "url": "${endpoint}" }
  }
}`,
    file: "~/.cursor/mcp.json",
    id: "cursor",
    label: "Cursor",
  },
  {
    config: (endpoint) => `{
  "servers": {
    "dietlownik": { "type": "http", "url": "${endpoint}" }
  }
}`,
    file: ".vscode/mcp.json",
    id: "vscode",
    label: "VS Code",
  },
  {
    config: (endpoint) => `{
  "mcpServers": {
    "dietlownik": { "serverUrl": "${endpoint}" }
  }
}`,
    file: "~/.codeium/windsurf/mcp_config.json",
    id: "windsurf",
    label: "Windsurf",
  },
];

const SparkIcon = ({ size = 15 }: Readonly<{ size?: number }>) => (
  <svg
    aria-hidden
    className="text-[var(--color-amber)]"
    fill="currentColor"
    height={size}
    viewBox="0 0 24 24"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M11 2.6 12.55 8.3 18.2 9.9 12.55 11.5 11 17.2 9.45 11.5 3.8 9.9 9.45 8.3Z" />
    <path d="M18.4 14.4 19.1 17 21.6 17.7 19.1 18.4 18.4 21 17.7 18.4 15.2 17.7 17.7 17Z" />
  </svg>
);

const CloseIcon = () => (
  <svg
    aria-hidden
    fill="none"
    height="13"
    stroke="currentColor"
    strokeWidth="1.5"
    viewBox="0 0 14 14"
    width="13"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M1.5 1.5 12.5 12.5M12.5 1.5 1.5 12.5" />
  </svg>
);

type CopyStatus = "copied" | "idle" | "selected";

/** Select the snippet in place so Ctrl+C still works when the Clipboard API
 *  is unavailable — it needs a focused document and a secure context, and
 *  neither is guaranteed (plain http on a LAN host, background tab). */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- HTMLElement is a built-in DOM class with mutating methods; the node is only handed to Range.selectNodeContents
const selectNode = (node: HTMLElement | null): boolean => {
  const selection = window.getSelection();
  if (node === null || selection === null) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const CopyButton = ({
  code,
  onFallback,
}: Readonly<{ code: string; onFallback: () => boolean }>) => {
  const [status, setStatus] = React.useState<CopyStatus>("idle");

  React.useEffect(() => {
    const t =
      status === "idle"
        ? undefined
        : setTimeout(() => {
            setStatus("idle");
          }, COPIED_MS);
    return () => {
      if (t !== undefined) {
        clearTimeout(t);
      }
    };
  }, [status]);

  const onCopy = React.useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setStatus("copied");
      } catch {
        setStatus(onFallback() ? "selected" : "idle");
      }
    })();
  }, [code, onFallback]);

  return (
    <button
      className="shrink-0 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-amber-deep)] transition-colors"
      onClick={onCopy}
      type="button"
    >
      {STATUS_LABEL[status]}
    </button>
  );
};

const SectionLabel = ({ children }: Readonly<{ children: string }>) => (
  <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
    {children}
  </span>
);

const Snippet = ({
  code,
  label,
  wrap,
}: Readonly<{ code: string; label: string; wrap?: boolean }>) => {
  const preRef = React.useRef<HTMLPreElement>(null);
  const onFallback = React.useCallback(() => selectNode(preRef.current), []);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>{label}</SectionLabel>
        <CopyButton code={code} onFallback={onFallback} />
      </div>
      <pre
        className={cn(
          "mt-1 rounded-sm border border-[var(--color-bone)] bg-[var(--color-oat)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--color-ink)]",
          wrap === true ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
        )}
        ref={preRef}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

const ConfigSnippet = ({ endpoint }: Readonly<{ endpoint: string }>) => {
  const [providerId, setProviderId] = React.useState(PROVIDERS[0].id);
  const preRef = React.useRef<HTMLPreElement>(null);
  const onFallback = React.useCallback(() => selectNode(preRef.current), []);

  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];
  const code = provider.config(endpoint);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Konfiguracja</SectionLabel>
        <CopyButton code={code} onFallback={onFallback} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {PROVIDERS.map((p) => (
          <button
            className={cn(
              "rounded-sm px-2 py-0.5 text-[12px] transition-colors",
              p.id === provider.id
                ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-3)] hover:bg-[var(--color-oat)]"
            )}
            key={p.id}
            onClick={() => {
              setProviderId(p.id);
            }}
            type="button"
          >
            {p.label}
          </button>
        ))}
      </div>
      <pre
        className="mt-1.5 overflow-x-auto rounded-sm border border-[var(--color-bone)] bg-[var(--color-oat)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--color-ink)]"
        ref={preRef}
      >
        <code>{code}</code>
      </pre>
      <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-3)]">
        {provider.file}
      </p>
    </div>
  );
};

const TITLE_ID = "mcp-connect-title";

const Dialog = ({
  endpoint,
  onClose,
}: Readonly<{ endpoint: string; onClose: () => void }>) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);

  // Move focus in on open, put it back on close, and keep the page behind
  // from scrolling under the dialog.
  React.useEffect(() => {
    const previous = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  React.useEffect(() => {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- KeyboardEvent is a built-in DOM class with mutating methods; the handler only reads .key/.shiftKey and calls preventDefault
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) {
        return;
      }
      const nodes = [
        ...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ];
      const [first] = nodes;
      const last = nodes.at(-1);
      if (first === undefined || last === undefined) {
        return;
      }
      // Wrap the cycle by hand: without this, Tab walks out of the dialog
      // and into the page behind it.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[oklch(22%_0.018_60_/_0.32)] px-4 py-8 animate-in fade-in-0 sm:py-12"
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.MouseEvent wraps a built-in DOM event; the handler only compares .target with .currentTarget
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={undefined}
      role="presentation"
    >
      <div
        aria-labelledby={TITLE_ID}
        aria-modal
        className="w-[min(94vw,640px)] rounded-md border border-[var(--color-bone)] bg-[var(--color-cream)] shadow-[0_24px_64px_-24px_oklch(22%_0.018_60_/_0.35)] animate-in fade-in-0 zoom-in-95"
        ref={panelRef}
        role="dialog"
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-bone)] px-5 py-4">
          <span className="mt-1">
            <SparkIcon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              className="font-display text-[17px] leading-tight text-[var(--color-ink)]"
              id={TITLE_ID}
            >
              Podłącz agenta
            </h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-[var(--color-ink-2)]">
              Podłącz Claude&apos;a albo innego klienta MCP i zapytaj: „Zamów
              catering z dobrym stosunkiem białka do ceny, 2500 kcal, bez
              pomidorów”.
            </p>
          </div>
          <button
            aria-label="Zamknij"
            className="-mr-1 shrink-0 rounded-sm p-1.5 text-[var(--color-ink-3)] hover:bg-[var(--color-oat)] hover:text-[var(--color-ink)] transition-colors"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <Snippet code={endpoint} label="Endpoint (streamable HTTP)" wrap />
          <Snippet
            code={`claude mcp add --transport http dietlownik ${endpoint}`}
            label="Claude Code"
            wrap
          />
          <ConfigSnippet endpoint={endpoint} />
        </div>
      </div>
    </div>,
    document.body
  );
};

export const McpConnect = () => {
  const [open, setOpen] = React.useState(false);
  const [origin, setOrigin] = React.useState(SSR_ORIGIN);

  React.useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const onClose = React.useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label="Podłącz agenta przez MCP"
        className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[var(--color-ink)] hover:bg-[var(--color-oat)] transition-colors"
        onClick={() => {
          setOpen(true);
        }}
        title="Podłącz agenta przez MCP"
        type="button"
      >
        <SparkIcon />
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
          MCP
        </span>
      </button>
      {open ? (
        <Dialog endpoint={`${origin}${MCP_PATH}`} onClose={onClose} />
      ) : null}
    </>
  );
};
