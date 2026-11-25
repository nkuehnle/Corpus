import { useEffect, useMemo, useState, type ReactNode } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { IN_APP } from "../platform";
import type { Loaded } from "../store";

const PATHS: Record<string, string> = {
  learn: "M4 19V6a2 2 0 0 1 2-2h13v13H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13M9 8h6",
  papers: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  datasets:
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  library: "M4 4v16M9 4v16M14 5l5 15M4 20h6",
  data: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4",
  star: "m12 3 2.7 5.8 6.3.8-4.6 4.3 1.2 6.3L12 17.1 6.4 20.2l1.2-6.3L3 9.6l6.3-.8z",
  video: "M4 5h16v14H4zM10 9l5 3-5 3z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  textbook: "M4 19V6a2 2 0 0 1 2-2h13v13H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13",
  pdf: "M7 3h7l5 5v13H7zM14 3v5h5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.link} />
    </svg>
  );
}

/** Icon tile for a list row; `kind` is a paper, dataset, search or resource kind. */
export function KindIcon({ kind }: { kind: string }) {
  const name = { paper: "papers", dataset: "datasets", resource: "link", script: "data" }[kind] ?? kind;
  return (
    <span className="kind-icon">
      <Icon name={name} />
    </span>
  );
}

export function Back({ to, label }: { to?: string; label: string }) {
  return (
    <button className="back-link" onClick={() => (to ? (window.location.hash = to) : window.history.back())}>
      ‹ {label}
    </button>
  );
}

/** Loading and error lines for a `useLoad` result; renders children once data is there. */
export function Await<T>({ of, children }: { of: Loaded<T>; children: (data: T) => ReactNode }) {
  if (of.error)
    return (
      <div className="status error">
        {of.error}{" "}
        <button className="button small" onClick={of.reload}>
          Try again
        </button>
      </div>
    );
  if (of.data === undefined) return <div className="status">Loading…</div>;
  return <>{children(of.data)}</>;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on wide windows. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Yes/no question as a native dialog (window.confirm doesn't work in every WebView). */
export async function ask(text: string): Promise<boolean> {
  if (!IN_APP) return window.confirm(text);
  return confirm(text, { title: "Corpus", kind: "warning" });
}

/** A notes box that saves when you leave it. */
export function Notes({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <textarea
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
    />
  );
}

export function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether a paper can be read without a subscription. */
export const AccessTag = ({ free }: { free: boolean }) => (
  <span className={`data-tag ${free ? "free" : "paywalled"}`}>{free ? "Free" : "Paywalled"}</span>
);
