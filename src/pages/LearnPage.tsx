import { useState } from "react";
import { Await, Back, Icon, KindIcon, Markdown, Notes, ask } from "../components/ui";
import { now, type Lesson, type LessonItem } from "../db/repo";
import { navigate, repo, useLoad } from "../store";

export function LearnPage() {
  const courses = useLoad(() => repo().courses(), []);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Learn</h1>
        <button className="icon-btn" aria-label="Settings" onClick={() => navigate("/settings")}>
          <Icon name="settings" />
        </button>
      </div>
      <Await of={courses}>
        {(list) =>
          list.length === 0 ? (
            <div className="card">
              <div className="card-title">No study plans yet</div>
              <p className="muted">
                A study plan is a set of lessons with the papers, videos, textbooks and datasets that go with them. Import one
                from a Corpus database file to get started.
              </p>
              <button className="button primary" onClick={() => navigate("/settings")}>
                Import a study plan
              </button>
            </div>
          ) : (
            list.map((c) => (
              <button key={c.uid} className="card" onClick={() => navigate(`/course/${encodeURIComponent(c.uid)}`)}>
                <div className="card-title">{c.title}</div>
                <div className="muted small">{c.description}</div>
                <div className="progress">
                  <div style={{ width: `${c.lessons ? (100 * c.done) / c.lessons : 0}%` }} />
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>
                  {c.done} of {c.lessons} lessons done
                </div>
              </button>
            ))
          )
        }
      </Await>
    </div>
  );
}

function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(minutes % 60 && minutes < 600 ? 1 : 0)} h`;
}

export function CoursePage({ uid }: { uid: string }) {
  const data = useLoad(async () => {
    const [course, modules, lessons] = await Promise.all([repo().course(uid), repo().modules(uid), repo().lessons(uid)]);
    return { course, modules, lessons };
  }, [uid]);
  return (
    <div className="page">
      <Back to="/learn" label="Learn" />
      <Await of={data}>
        {({ course, modules, lessons }) => {
          if (!course) return <div className="status">This study plan is no longer here.</div>;
          const next = lessons.find((l) => !l.done_at);
          const left = lessons.filter((l) => !l.done_at).reduce((n, l) => n + l.minutes, 0);
          return (
            <>
              <h1 className="page-title">{course.title}</h1>
              <p className="muted">{course.description}</p>
              {next ? (
                <button className="card callout" onClick={() => navigate(`/lesson/${encodeURIComponent(next.uid)}`)}>
                  <span className="muted small">Up next · about {hours(left)} of study left</span>
                  <span className="card-title">{next.title}</span>
                </button>
              ) : (
                <div className="card">Every lesson is done.</div>
              )}
              {modules.map((m, i) => (
                <section key={m.uid}>
                  <h2 className="section-title" style={{ marginTop: 20 }}>
                    {i + 1}. {m.title}
                  </h2>
                  <p className="muted small">{m.summary}</p>
                  <div className="list">
                    {lessons
                      .filter((l) => l.module_uid === m.uid)
                      .map((l) => (
                        <button key={l.uid} className="item" onClick={() => navigate(`/lesson/${encodeURIComponent(l.uid)}`)}>
                          <span className={`check ${l.done_at ? "done" : ""}`}>{l.done_at ? "✓" : ""}</span>
                          <span className="item-main">
                            <span className="item-title">{l.title}</span>
                          </span>
                          <span className="item-side">{hours(l.minutes)}</span>
                        </button>
                      ))}
                  </div>
                </section>
              ))}
              <button
                className="button small"
                onClick={async () => {
                  if (!(await ask(`Remove “${course.title}” and its lessons? Papers and resources stay in your library.`)))
                    return;
                  await repo().removeCourse(uid);
                  navigate("/learn");
                }}
              >
                Remove this study plan
              </button>
            </>
          );
        }}
      </Await>
    </div>
  );
}

function itemRoute(item: LessonItem): string {
  const ref = encodeURIComponent(item.ref_uid);
  switch (item.kind) {
    case "paper":
      return `/paper/${ref.replace(/^pmid%3A/, "")}`;
    case "dataset":
      return `/dataset/${ref}`;
    case "search":
      return `/alert/${ref}`;
    default:
      return `/resource/${ref}`;
  }
}

const GROUPS: { kind: LessonItem["kind"]; title: string }[] = [
  { kind: "resource", title: "Watch and read" },
  { kind: "paper", title: "Papers" },
  { kind: "dataset", title: "Datasets to explore" },
  { kind: "search", title: "Keep up with the literature" },
];

export function LessonPage({ uid }: { uid: string }) {
  const data = useLoad(async () => {
    const lesson = await repo().lesson(uid);
    const courseUid = await repo().lessonCourse(uid);
    const [items, siblings] = await Promise.all([repo().lessonItems(uid), courseUid ? repo().lessons(courseUid) : []]);
    return { lesson, courseUid, items, siblings };
  }, [uid]);
  const [done, setDone] = useState<boolean | null>(null);

  return (
    <div className="page">
      <Await of={data}>
        {({ lesson, courseUid, items, siblings }) => {
          if (!lesson) return <div className="status">This lesson is no longer here.</div>;
          const at = siblings.findIndex((l) => l.uid === uid);
          const prev: Lesson | undefined = siblings[at - 1];
          const next: Lesson | undefined = siblings[at + 1];
          const isDone = done ?? !!lesson.done_at;
          const toggle = async () => {
            await repo().updateLesson(uid, { done_at: isDone ? null : now() });
            setDone(!isDone);
          };
          return (
            <>
              <Back to={courseUid ? `/course/${encodeURIComponent(courseUid)}` : "/learn"} label="Study plan" />
              <h1 className="page-title">{lesson.title}</h1>
              <div className="muted small" style={{ marginTop: -10, marginBottom: 12 }}>
                Lesson {at + 1} of {siblings.length} · about {hours(lesson.minutes)}
              </div>

              {lesson.objectives && (
                <div className="card">
                  <div className="card-title">By the end you should be able to</div>
                  <Markdown text={lesson.objectives} />
                </div>
              )}
              <Markdown text={lesson.body} />

              {GROUPS.map((g) => {
                const group = items.filter((i) => i.kind === g.kind);
                if (!group.length) return null;
                return (
                  <section key={g.kind}>
                    <h2 className="section-title" style={{ marginTop: 20 }}>
                      {g.title}
                    </h2>
                    <div className="list">
                      {group.map((i) => (
                        <button key={i.uid} className="item" disabled={!i.title} onClick={() => navigate(itemRoute(i))}>
                          <KindIcon kind={i.kind === "resource" ? (i.detail?.split(" · ")[0] ?? "link") : i.kind} />
                          <span className="item-main">
                            <span className="item-title">{i.title ?? "Missing from this database"}</span>
                            <div className="item-meta">{i.detail}</div>
                            {i.note && <div className="item-meta">{i.note}</div>}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}

              {lesson.questions && (
                <section>
                  <h2 className="section-title" style={{ marginTop: 20 }}>
                    Check your understanding
                  </h2>
                  <div className="card">
                    <Markdown text={lesson.questions} />
                  </div>
                </section>
              )}

              <h2 className="section-title" style={{ marginTop: 20 }}>
                Your notes
              </h2>
              <Notes
                value={lesson.notes}
                placeholder="What stuck, what didn't, what to look up"
                onSave={(notes) => repo().updateLesson(uid, { notes })}
              />

              <div className="row">
                <button className={`button ${isDone ? "" : "primary"}`} onClick={toggle}>
                  {isDone ? "✓ Done · mark as not done" : "Mark lesson done"}
                </button>
              </div>
              <div className="lesson-nav">
                {prev ? (
                  <button className="button" onClick={() => navigate(`/lesson/${encodeURIComponent(prev.uid)}`)}>
                    ‹ {prev.title}
                  </button>
                ) : (
                  <span />
                )}
                {next && (
                  <button className="button" onClick={() => navigate(`/lesson/${encodeURIComponent(next.uid)}`)}>
                    {next.title} ›
                  </button>
                )}
              </div>
            </>
          );
        }}
      </Await>
    </div>
  );
}
