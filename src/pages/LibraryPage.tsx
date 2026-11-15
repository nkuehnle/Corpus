import { useState } from "react";
import { Await, Back, Icon, KindIcon, Modal, Segmented, ask, errorText } from "../components/ui";
import { newUid, type Resource, type ResourceKind } from "../db/repo";
import { IN_APP, importFile, openExternal, pickFile, removeStored, type Picked } from "../platform";
import { navigate, repo, useLoad } from "../store";

const KIND_LABEL: Record<ResourceKind, string> = { video: "Video", link: "Link", textbook: "Textbook", pdf: "PDF" };

/** The YouTube video id in a watch, share or embed link, if it is one. */
export function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function AddResource({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<ResourceKind>("video");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const takesFile = kind === "pdf" || kind === "textbook";
  const valid = title.trim() && (picked || /^https?:\/\/\S+$/.test(url.trim()));

  const choose = async () => {
    const file = await pickFile(["pdf"]);
    if (!file) return;
    setPicked(file);
    if (!title) setTitle(file.name.replace(/\.pdf$/i, ""));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const uid = newUid("res");
      const file = picked ? await importFile(picked, `files/${uid.slice(4)}.pdf`) : null;
      await repo().addResource({
        uid,
        kind,
        title: title.trim(),
        url: url.trim() || null,
        file,
        author: author.trim(),
        description: description.trim(),
      });
      onAdded();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add to library" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Segmented
          value={kind}
          options={(Object.keys(KIND_LABEL) as ResourceKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={(k) => {
            setKind(k);
            setPicked(null);
          }}
        />
        {takesFile && IN_APP && (
          <div>
            <button type="button" className="button" onClick={choose}>
              {picked ? "Choose a different PDF" : "Choose a PDF from this device"}
            </button>
            {picked && <div className="muted small">{picked.name} will be copied into Corpus.</div>}
          </div>
        )}
        <label>
          {takesFile ? "Web address (optional if you chose a file)" : "Web address"}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            inputMode="url"
            autoCapitalize="none"
          />
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          {kind === "video" ? "Channel or speaker" : "Author"}
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <div className="status error">{error}</div>}
        <button className="button primary" disabled={!valid || busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
    </Modal>
  );
}

export function LibraryPage() {
  const data = useLoad(() => repo().resources(), []);
  const [filter, setFilter] = useState<"all" | ResourceKind>("all");
  const [adding, setAdding] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Library</h1>
        <button className="button primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          &nbsp;Add
        </button>
      </div>
      <Await of={data}>
        {(all) => {
          if (!all.length)
            return <div className="status">Add videos, links, textbooks and PDFs to keep them next to your papers.</div>;
          const shown = all.filter((r) => filter === "all" || r.kind === filter);
          return (
            <>
              <Segmented
                value={filter}
                options={[
                  { value: "all", label: `All ${all.length}` },
                  { value: "video", label: "Videos" },
                  { value: "textbook", label: "Textbooks" },
                  { value: "pdf", label: "PDFs" },
                  { value: "link", label: "Links" },
                ]}
                onChange={setFilter}
              />
              {shown.length === 0 && <div className="status">Nothing here.</div>}
              <div className="list">
                {shown.map((r) => (
                  <button key={r.uid} className="item" onClick={() => navigate(`/resource/${encodeURIComponent(r.uid)}`)}>
                    <KindIcon kind={r.kind} />
                    <span className="item-main">
                      <span className="item-title">{r.title}</span>
                      <div className="item-meta">{[KIND_LABEL[r.kind], r.author].filter(Boolean).join(" · ")}</div>
                    </span>
                  </button>
                ))}
              </div>
            </>
          );
        }}
      </Await>
      {adding && (
        <AddResource
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            data.reload();
          }}
        />
      )}
    </div>
  );
}

export function ResourcePage({ uid }: { uid: string }) {
  const data = useLoad(() => repo().resource(uid), [uid]);
  const [error, setError] = useState<string | null>(null);

  const attach = async (r: Resource) => {
    const file = await pickFile(["pdf"]);
    if (!file) return;
    try {
      await repo().updateResource(uid, { file: await importFile(file, `files/${uid.replace(/[^\w-]/g, "_")}.pdf`) });
      data.reload();
    } catch (e) {
      setError(`${r.title}: ${errorText(e)}`);
    }
  };

  return (
    <div className="page">
      <Back label="Back" />
      <Await of={data}>
        {(r) => {
          if (!r) return <div className="status">This item is no longer in your library.</div>;
          const video = r.url ? youtubeId(r.url) : null;
          const takesFile = r.kind === "pdf" || r.kind === "textbook";
          return (
            <>
              <h1 className="page-title" style={{ fontSize: "1.3rem" }}>
                {r.title}
              </h1>
              <p className="muted" style={{ marginTop: -8 }}>
                {[KIND_LABEL[r.kind], r.author].filter(Boolean).join(" · ")}
              </p>
              {video && (
                <iframe
                  className="video-frame"
                  src={`https://www.youtube-nocookie.com/embed/${video}`}
                  title={r.title}
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              )}
              <div className="row" style={{ marginBottom: 12 }}>
                {r.file && (
                  <button className="button primary" onClick={() => navigate(`/pdf/${encodeURIComponent(uid)}`)}>
                    {r.position ? `Continue reading · page ${r.position}` : "Read"}
                  </button>
                )}
                {r.url && (
                  <button className={`button ${r.file ? "" : "primary"}`} onClick={() => openExternal(r.url!)}>
                    {video ? "Open in YouTube" : "Open link"}
                  </button>
                )}
                {takesFile && IN_APP && (
                  <button className="button" onClick={() => attach(r)}>
                    {r.file ? "Replace PDF" : "Attach a PDF from this device"}
                  </button>
                )}
              </div>
              {error && <div className="status error">{error}</div>}
              {r.description && <p style={{ whiteSpace: "pre-wrap" }}>{r.description}</p>}
              {r.url && (
                <p className="muted small" style={{ overflowWrap: "anywhere" }}>
                  {r.url}
                </p>
              )}
              <button
                className="button small"
                onClick={async () => {
                  if (!(await ask(`Remove “${r.title}” from your library?`))) return;
                  if (r.file) await removeStored(r.file);
                  await repo().removeResource(uid);
                  navigate("/library");
                }}
              >
                Remove from library
              </button>
            </>
          );
        }}
      </Await>
    </div>
  );
}
