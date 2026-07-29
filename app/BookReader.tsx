"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase-browser";

type Block = {
  id: string;
  type: "paragraph" | "quote" | "list" | "subheading";
  text: string;
};
type Chapter = { id: string; title: string; blocks: Block[] };
type Part = { id: string; title: string; chapters: Chapter[] };
type Book = {
  title: string;
  subtitle: string;
  partCount: number;
  chapterCount: number;
  parts: Part[];
};
type Annotation = {
  id: number;
  chapterId: string;
  paragraphId: string | null;
  kind: "note" | "plan" | "revision";
  content: string;
  imageKey: string | null;
  imageName: string | null;
  isPublic: boolean;
  updatedAt: string | number;
};

const labels = { note: "批注", plan: "计划", revision: "个人修订" } as const;

export default function BookReader() {
  const [book, setBook] = useState<Book | null>(null);
  const [chapterId, setChapterId] = useState("chapter-001");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedParts, setExpandedParts] = useState<Set<string>>(new Set(["part-001"]));
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [kind, setKind] = useState<Annotation["kind"]>("note");
  const [content, setContent] = useState("");
  const [paragraphId, setParagraphId] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ key: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState<"saved" | "saving" | "offline">("saved");
  const [showRevisions, setShowRevisions] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [publishNote, setPublishNote] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loginSending, setLoginSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/book.json`)
      .then((response) => response.json())
      .then((data: Book) => setBook(data));
    supabase.auth.getSession().then(({ data }) => setAccessToken(data.session?.access_token || null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token || null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const owner = data.user?.email?.toLowerCase() ===
        process.env.NEXT_PUBLIC_SITE_OWNER_EMAIL?.toLowerCase();
      setIsOwner(Boolean(owner));
      if (!owner) return;
      supabase.from("reading_progress").select("chapter_id").maybeSingle()
        .then(({ data: progress }) => progress?.chapter_id && setChapterId(progress.chapter_id));
    });
  }, [accessToken]);

  useEffect(() => {
    if (!book) return;
    setSyncState("saving");
    void (async () => {
      try {
        const { data, error } = await supabase.from("annotations").select("*")
          .eq("chapter_id", chapterId).order("updated_at", { ascending: false });
        if (error) throw error;
        setAnnotations((data || []).map(rowToAnnotation));
        setSyncState("saved");
      } catch {
        setAnnotations([]);
        setSyncState("offline");
      }
    })();
    if (isOwner) {
      void (async () => {
        const { data } = await supabase.auth.getUser();
        if (data.user) {
          await supabase.from("reading_progress").upsert({
            owner: data.user.id,
            chapter_id: chapterId,
            updated_at: new Date().toISOString(),
          });
        }
      })();
    }
  }, [book, chapterId, accessToken, isOwner]);

  async function sendLoginLink() {
    setLoginSending(true);
    const email = window.prompt("请输入作者邮箱");
    if (email) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      window.alert(error ? `发送失败：${error.message}` : "登录邮件已发送，请在邮箱中点击链接。");
    }
    setLoginSending(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setIsOwner(false);
  }

  const flatChapters = useMemo(
    () =>
      book?.parts.flatMap((part) =>
        part.chapters.map((chapter) => ({ ...chapter, partTitle: part.title })),
      ) || [],
    [book],
  );
  const chapterIndex = Math.max(
    0,
    flatChapters.findIndex((chapter) => chapter.id === chapterId),
  );
  const chapter = flatChapters[chapterIndex];
  const revisionMap = useMemo(() => {
    const map = new Map<string, Annotation>();
    annotations
      .filter((item) => item.kind === "revision" && item.paragraphId)
      .forEach((item) => {
        if (!map.has(item.paragraphId!)) map.set(item.paragraphId!, item);
      });
    return map;
  }, [annotations]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return flatChapters
      .filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.blocks.some((block) => block.text.toLowerCase().includes(query)),
      )
      .slice(0, 20);
  }, [flatChapters, search]);

  function chooseChapter(nextChapterId: string) {
    setChapterId(nextChapterId);
    setParagraphId(null);
    setDirectoryOpen(false);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startAnnotation(block: Block, nextKind: Annotation["kind"] = "note") {
    setParagraphId(block.id);
    setKind(nextKind);
    if (nextKind === "revision") {
      setContent(revisionMap.get(block.id)?.content || block.text);
    } else {
      setContent("");
    }
    setNotesOpen(true);
    requestAnimationFrame(() => document.getElementById("annotation-input")?.focus());
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const sourceFile = event.target.files?.[0];
    if (!sourceFile) return;
    setSaving(true);
    try {
      const file = await compressImage(sourceFile);
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `${auth.user.id}/${crypto.randomUUID()}-${safeName}`;
      const { error } = await supabase.storage.from("book-images").upload(key, file, {
        contentType: file.type,
      });
      if (error) throw error;
      setUpload({ key, name: file.name });
      setSyncState("saved");
    } catch {
      setSyncState("offline");
    } finally {
      setSaving(false);
    }
  }

  async function saveAnnotation() {
    if (!content.trim() || !chapter) return;
    setSaving(true);
    setSyncState("saving");
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error();
      const { data, error } = await supabase.from("annotations").insert({
        owner: auth.user.id,
        owner_email: auth.user.email,
        chapter_id: chapter.id,
        paragraph_id: paragraphId,
        kind,
        content: content.trim(),
        image_key: upload?.key || null,
        image_name: upload?.name || null,
        is_public: kind === "note" && publishNote,
      }).select("*").single();
      if (error || !data) throw error || new Error();
      setAnnotations((items) => [rowToAnnotation(data), ...items]);
      setContent("");
      setParagraphId(null);
      setUpload(null);
      setPublishNote(false);
      setSyncState("saved");
    } catch {
      setSyncState("offline");
    } finally {
      setSaving(false);
    }
  }

  async function removeAnnotation(id: number) {
    const { error } = await supabase.from("annotations").delete().eq("id", id);
    if (!error) setAnnotations((items) => items.filter((item) => item.id !== id));
  }

  if (!book || !chapter) {
    return (
      <main className="loading">
        <div className="book-mark">赵</div>
        <p>正在打开你的个人书房…</p>
      </main>
    );
  }

  return (
    <main className="reader-shell">
      <header className="topbar">
        <button className="brand" onClick={() => chooseChapter("chapter-001")}>
          <span className="brand-mark">赵</span>
          <span>
            <strong>{book.title}</strong>
            <small>个人书房</small>
          </span>
        </button>
        <div className="top-actions">
          <span className={`sync ${syncState}`}>
            <i />
            {syncState === "saved" ? "已同步" : syncState === "saving" ? "保存中" : "等待联网"}
          </span>
          <button className="quiet-button" onClick={() => setDirectoryOpen(true)}>
            目录
          </button>
          <button className="primary-button" onClick={() => setNotesOpen(!notesOpen)}>
            {notesOpen ? "收起批注" : isOwner ? "管理批注" : "精选批注"}
          </button>
          {isOwner && <button className="quiet-button" onClick={signOut}>退出</button>}
        </div>
      </header>

      <aside className={`directory ${directoryOpen ? "mobile-open" : ""}`}>
        <div className="side-heading">
          <div>
            <span>全书目录</span>
            <small>{book.partCount} 部分 · {book.chapterCount} 章</small>
          </div>
          <button className="mobile-close" onClick={() => setDirectoryOpen(false)}>×</button>
        </div>
        <div className="search-wrap">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索章节或正文"
            aria-label="搜索书本内容"
          />
        </div>
        {search ? (
          <div className="search-results">
            <p>找到 {searchResults.length} 个相关章节</p>
            {searchResults.map((item) => (
              <button key={item.id} onClick={() => chooseChapter(item.id)}>
                <strong>{item.title}</strong>
                <small>{item.partTitle}</small>
              </button>
            ))}
          </div>
        ) : (
          <nav className="toc">
            {book.parts.map((part) => {
              const open = expandedParts.has(part.id);
              const active = part.chapters.some((item) => item.id === chapter.id);
              return (
                <section key={part.id}>
                  <button
                    className={`part-button ${active ? "active" : ""}`}
                    onClick={() =>
                      setExpandedParts((current) => {
                        const next = new Set(current);
                        open ? next.delete(part.id) : next.add(part.id);
                        return next;
                      })
                    }
                  >
                    <span>{part.title}</span>
                    <b>{open ? "−" : "+"}</b>
                  </button>
                  {open && (
                    <div className="chapter-list">
                      {part.chapters.map((item) => (
                        <button
                          key={item.id}
                          className={item.id === chapter.id ? "selected" : ""}
                          onClick={() => chooseChapter(item.id)}
                        >
                          {item.title}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </nav>
        )}
      </aside>

      <article className={`book-page ${notesOpen ? "" : "wide"}`}>
        <div className="chapter-kicker">{chapter.partTitle}</div>
        <h1>{chapter.title}</h1>
        <div className="chapter-rule"><span /></div>
        <div className="reading-hint">点击任意段落，可以添加批注或保存个人修订</div>
        <div className="prose">
          {chapter.blocks.map((block) => {
            const revision = showRevisions ? revisionMap.get(block.id) : undefined;
            const text = revision?.content || block.text;
            const Tag = block.type === "subheading" ? "h2" : block.type === "quote" ? "blockquote" : "p";
            return (
              <div
                key={block.id}
                id={block.id}
                className={`paragraph-row ${paragraphId === block.id ? "focused" : ""} ${revision ? "revised" : ""}`}
              >
                <Tag className={block.type === "list" ? "list-line" : ""}>{text}</Tag>
                {revision && <span className="revision-flag">个人修订</span>}
                {isOwner && (
                  <div className="paragraph-tools">
                    <button onClick={() => startAnnotation(block)}>＋批注</button>
                    <button onClick={() => startAnnotation(block, "revision")}>修订</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <footer className="chapter-nav">
          <button
            disabled={chapterIndex === 0}
            onClick={() => chooseChapter(flatChapters[chapterIndex - 1].id)}
          >
            ← 上一章
          </button>
          <span>{chapterIndex + 1} / {flatChapters.length}</span>
          <button
            disabled={chapterIndex === flatChapters.length - 1}
            onClick={() => chooseChapter(flatChapters[chapterIndex + 1].id)}
          >
            下一章 →
          </button>
        </footer>
      </article>

      <aside className={`notes-panel ${notesOpen ? "open" : ""}`}>
        <div className="notes-head">
          <div>
            <span>本章批注</span>
            <small>{annotations.length} 条内容</small>
          </div>
          <button onClick={() => setNotesOpen(false)}>×</button>
        </div>
        {isOwner ? (
          <>
            <div className="type-tabs">
              {(["note", "plan", "revision"] as const).map((item) => (
                <button
                  key={item}
                  className={kind === item ? "active" : ""}
                  onClick={() => setKind(item)}
                >
                  {labels[item]}
                </button>
              ))}
            </div>
            <div className="composer">
              {paragraphId && (
                <div className="anchor-chip">
                  已关联正文
                  <button onClick={() => setParagraphId(null)}>×</button>
                </div>
              )}
              <textarea
                id="annotation-input"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={
                  kind === "plan"
                    ? "把这一章变成一个可以执行的计划…"
                    : kind === "revision"
                      ? "写下你的个人版本，原文仍会完整保留…"
                      : "写下此刻的想法、疑问或提醒…"
                }
              />
              {upload && <div className="upload-chip">图片：{upload.name}</div>}
              {kind === "note" && (
                <label className="publish-toggle">
                  <input
                    type="checkbox"
                    checked={publishNote}
                    onChange={(event) => setPublishNote(event.target.checked)}
                  />
                  作为精选批注公开给访客
                </label>
              )}
              <div className="composer-actions">
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
                <button className="image-button" onClick={() => fileRef.current?.click()}>
                  ＋ 图片
                </button>
                <button
                  className="save-button"
                  disabled={!content.trim() || saving}
                  onClick={saveAnnotation}
                >
                  {saving ? "保存中…" : `保存${labels[kind]}`}
                </button>
              </div>
            </div>
            <label className="revision-toggle">
              <input
                type="checkbox"
                checked={showRevisions}
                onChange={(event) => setShowRevisions(event.target.checked)}
              />
              在正文中显示个人修订
            </label>
          </>
        ) : (
          <div className="visitor-note">
            <strong>这里展示赵铮然公开的精选批注</strong>
            <p>私人计划、个人修订和未公开批注不会展示。</p>
            <button className="login-button" disabled={loginSending} onClick={sendLoginLink}>
              {loginSending ? "正在发送…" : "作者登录"}
            </button>
          </div>
        )}
        <div className="annotation-list">
          {annotations.length === 0 ? (
            <div className="empty-notes">
              <span>✎</span>
              <p>这一章还没有批注</p>
              <small>你的内容会单独保存，不会改坏原书。</small>
            </div>
          ) : (
            annotations.map((item) => (
              <div className={`annotation-card ${item.kind}`} key={item.id}>
                <div className="card-meta">
                  <span>{item.isPublic ? "公开精选批注" : labels[item.kind]}</span>
                  {isOwner && <button onClick={() => removeAnnotation(item.id)}>删除</button>}
                </div>
                <p>{item.content}</p>
                {item.imageKey && (
                  <AnnotationImage
                    imageKey={item.imageKey}
                    imageName={item.imageName}
                    accessToken={accessToken}
                  />
                )}
                {item.paragraphId && (
                  <button
                    className="jump-link"
                    onClick={() => document.getElementById(item.paragraphId!)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  >
                    查看关联原文 ↗
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      <nav className="mobile-nav">
        <button onClick={() => setDirectoryOpen(true)}>☰<span>目录</span></button>
        <button onClick={() => setNotesOpen(true)}>✎<span>{isOwner ? "批注" : "精选"}</span></button>
        {isOwner ? (
          <button onClick={() => { setKind("plan"); setNotesOpen(true); }}>✓<span>计划</span></button>
        ) : (
          <button onClick={sendLoginLink}>⌁<span>作者登录</span></button>
        )}
      </nav>
      {directoryOpen && <button className="scrim" onClick={() => setDirectoryOpen(false)} aria-label="关闭目录" />}
    </main>
  );
}

function AnnotationImage({
  imageKey,
  imageName,
  accessToken,
}: {
  imageKey: string;
  imageName: string | null;
  accessToken: string | null;
}) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let objectUrl = "";
    supabase.storage.from("book-images").download(imageKey)
      .then(({ data, error }) => error || !data ? Promise.reject(error) : data)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => setSrc(""));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imageKey, accessToken]);
  return src ? <img src={src} alt={imageName || "批注图片"} /> : null;
}

function rowToAnnotation(row: Record<string, any>): Annotation {
  return {
    id: Number(row.id),
    chapterId: row.chapter_id,
    paragraphId: row.paragraph_id,
    kind: row.kind,
    content: row.content,
    imageKey: row.image_key,
    imageName: row.image_name,
    isPublic: Boolean(row.is_public),
    updatedAt: row.updated_at,
  };
}

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 650 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("image compression failed"))),
      "image/jpeg",
      0.76,
    ),
  );
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
    type: "image/jpeg",
  });
}
