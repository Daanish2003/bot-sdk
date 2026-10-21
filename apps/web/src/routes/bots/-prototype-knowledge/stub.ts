// PROTOTYPE (#734): in-memory stub for the Knowledge UI. Nothing touches the server or the Computer.
// Knowledge is the user's, shared by all their Bots, in /home/user/shared/knowledge/ (#729).
import { useCallback, useEffect, useRef, useState } from "react";

export const ROOT = "/home/user/shared/knowledge/";
export const CAP_KB = 50 * 1024;
const UPLOAD_CAP_KB = 20 * 1024;

export type Status = "ready" | "uploading" | "converting" | "waking" | "refused";

export type KFile = {
  /** Relative to ROOT, folders allowed: "clients/acme.md". */
  path: string;
  sizeKb: number;
  savedBy: "you" | "Planner" | "Researcher";
  addedAt: string;
  status: Status;
  /** Refusal reason; a refused row is not in Knowledge (nothing left behind). */
  reason?: string;
  /** PDF and DOCX only: the readable `<name>.md` beside the original (#730). */
  copy?: { sizeKb: number; text: string };
  /** Plain-text formats are their own readable text. */
  text?: string;
};

export type Item =
  | { kind: "user"; text: string; attachment?: string }
  | { kind: "bot"; text: string }
  | { kind: "upload"; path: string }
  | { kind: "saved"; path: string; by: string };

export type Ask = { path: string; sizeKb: number };

const handbookMd = `# Employee handbook

## Page 11

Holidays. Every employee gets 25 days of paid holiday a year, plus public holidays…

## Page 12

Parental leave. Employees who have worked here for six months get 16 weeks of
parental leave at full pay, and a further 10 weeks at half pay. Tell your
manager at least 8 weeks before the leave starts…

## Page 13

Sick leave. …`;

const seed: KFile[] = [
  {
    path: "Employee handbook.pdf",
    sizeKb: 4300,
    savedBy: "you",
    addedAt: "Oct 3",
    status: "ready",
    copy: { sizeKb: 310, text: handbookMd },
  },
  {
    path: "Benefits 2026.docx",
    sizeKb: 1130,
    savedBy: "you",
    addedAt: "Oct 3",
    status: "ready",
    copy: { sizeKb: 48, text: "# Benefits 2026\n\n## Health\n\nPrivate health cover for you and…" },
  },
  {
    path: "Brand guidelines.pdf",
    sizeKb: 14800,
    savedBy: "you",
    addedAt: "Oct 9",
    status: "ready",
    copy: { sizeKb: 120, text: "# Brand guidelines\n\n## Page 1\n\nOur logo…" },
  },
  {
    path: "Sales playbook.pdf",
    sizeKb: 10000,
    savedBy: "you",
    addedAt: "Oct 9",
    status: "ready",
    copy: { sizeKb: 400, text: "# Sales playbook\n\n## Page 1\n\nDiscovery calls…" },
  },
  {
    path: "Onboarding.html",
    sizeKb: 90,
    savedBy: "you",
    addedAt: "Oct 12",
    status: "ready",
    text: "<h1>Onboarding</h1><p>Day one: laptop, accounts, buddy…</p>",
  },
  {
    path: "clients/acme.md",
    sizeKb: 12,
    savedBy: "you",
    addedAt: "Oct 14",
    status: "ready",
    text: "# Acme Corp\n\n- Contact: Dana Ruiz, Head of Ops\n- Renewal: March\n- Prefers email over calls",
  },
  {
    path: "clients/globex.csv",
    sizeKb: 220,
    savedBy: "you",
    addedAt: "Oct 14",
    status: "ready",
    text: "date,order,amount\n2026-09-01,1041,1200\n2026-09-14,1077,860\n…",
  },
  {
    path: "reports/q3-competitors.md",
    sizeKb: 18,
    savedBy: "Planner",
    addedAt: "Oct 20",
    status: "ready",
    text: "# Q3 competitors\n\nSaved by Planner when you asked it to keep the research.\n\n1. Initech: cut prices 10%…",
  },
];

const seedItems: Item[] = [
  {
    kind: "user",
    text: "Compare our three biggest competitors this quarter and keep it for later.",
  },
  {
    kind: "bot",
    text: "Done. Initech cut prices by 10%, Umbrella launched a self-serve plan, and Hooli is hiring sales in Europe. I saved the full write-up to your Knowledge as reports/q3-competitors.md.",
  },
  { kind: "saved", path: "reports/q3-competitors.md", by: "Planner" },
  { kind: "user", text: "How much parental leave do I get?" },
  {
    kind: "bot",
    text: "After six months here you get 16 weeks at full pay, then 10 more weeks at half pay. Tell your manager at least 8 weeks before it starts (Employee handbook.pdf, page 12).",
  },
];

export function totalKb(files: KFile[]) {
  return files
    .filter((f) => f.status === "ready")
    .reduce((sum, f) => sum + f.sizeKb + (f.copy?.sizeKb ?? 0), 0);
}

export function mb(kb: number) {
  return kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;
}

export function usageText(files: KFile[]) {
  return `${mb(totalKb(files))} of ${mb(CAP_KB)}`;
}

export const statusText: Record<Status, string> = {
  ready: "",
  uploading: "Uploading…",
  converting: "Converting…",
  waking: "Waking your Computer…",
  refused: "Not added",
};

export const isConverted = (path: string) => /\.(pdf|docx)$/i.test(path);
export const baseName = (path: string) => path.split("/").at(-1) ?? path;
export const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

export function useKnowledgeStub() {
  const [files, setFiles] = useState<KFile[]>(seed);
  const [folders, setFolders] = useState<string[]>(["clients", "reports"]);
  const [items, setItems] = useState<Item[]>(seedItems);
  const [ask, setAsk] = useState<Ask | null>(null);
  const timers = useRef<number[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const patch = useCallback((path: string, change: Partial<KFile>) => {
    setFiles((all) => all.map((f) => (f.path === path ? { ...f, ...change } : f)));
  }, []);

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** Runs one upload through the states; `refuse` names the step that refuses it and why. */
  const run = useCallback(
    (
      file: Omit<KFile, "status" | "savedBy" | "addedAt">,
      opts: { refuse?: { at: Status; reason: string }; inThread?: boolean } = {},
    ) => {
      setFiles((all) => [
        ...all.filter((f) => f.path !== file.path || f.status === "ready"),
        { ...file, savedBy: "you", addedAt: "now", status: "uploading" },
      ]);
      if (opts.inThread)
        setItems((all) => [
          ...all,
          { kind: "user", text: "Add this to Knowledge.", attachment: file.path },
          { kind: "upload", path: file.path },
        ]);
      const steps: Status[] =
        opts.refuse?.at === "uploading"
          ? ["uploading"]
          : isConverted(file.path)
            ? ["converting", "waking", "ready"]
            : ["waking", "ready"];
      let at = 0;
      for (const step of steps) {
        at += 1200;
        const refuse = opts.refuse;
        later(at, () => {
          if (refuse && refuse.at === step) {
            patch(file.path, { status: "refused", reason: refuse.reason });
            return;
          }
          if (step === "ready") {
            // Replace: the new row takes the old one's place, original and copy together.
            setFiles((all) => {
              const fresh = all.find((f) => f.path === file.path && f.status !== "ready");
              const rest = all.filter((f) => f.path !== file.path);
              return fresh ? [...rest, { ...fresh, status: "ready" }] : all;
            });
            return;
          }
          patch(file.path, { status: step });
        });
        if (refuse && refuse.at === step) break;
      }
    },
    [patch],
  );

  const exists = (path: string) =>
    filesRef.current.some((f) => f.path === path && f.status === "ready");

  const upload = (inThread = false) => {
    const path = "New hire checklist.pdf";
    if (exists(path)) return setAsk({ path, sizeKb: 640 });
    run(
      {
        path,
        sizeKb: 640,
        copy: {
          sizeKb: 22,
          text: "# New hire checklist\n\n## Page 1\n\n1. Laptop\n2. Accounts\n3. Buddy…",
        },
      },
      { inThread },
    );
  };

  const scan = (inThread = false) =>
    run(
      { path: "Signed contract (scan).pdf", sizeKb: 3100 },
      {
        inThread,
        refuse: { at: "converting", reason: "This PDF has no text to read (it may be a scan)" },
      },
    );

  const full = (inThread = false) => {
    const used = totalKb(filesRef.current);
    const sizeKb = 19500;
    run(
      { path: "Board pack Q3.pdf", sizeKb },
      {
        inThread,
        refuse: {
          at: "converting",
          reason: `Knowledge is full: ${mb(used)} of ${mb(CAP_KB)} used, and this file needs ${mb(sizeKb + 600)}. Delete something first.`,
        },
      },
    );
  };

  const tooBig = (inThread = false) =>
    run(
      { path: "All-hands recording transcript.pdf", sizeKb: UPLOAD_CAP_KB + 4000 },
      {
        inThread,
        refuse: { at: "uploading", reason: "Files can be at most 20 MB (this one is 24 MB)" },
      },
    );

  /** Uploads the handbook again: same name, same folder, so it asks first. */
  const replace = () => setAsk({ path: "Employee handbook.pdf", sizeKb: 4400 });

  const confirmReplace = (inThread = false) => {
    if (!ask) return;
    const old = filesRef.current.find((f) => f.path === ask.path);
    run({ path: ask.path, sizeKb: ask.sizeKb, copy: old?.copy, text: old?.text }, { inThread });
    setAsk(null);
  };

  /** Deletes the original and its `.md` copy together (#731). */
  const remove = (path: string) => setFiles((all) => all.filter((f) => f.path !== path));

  const dismiss = (path: string) =>
    setFiles((all) => all.filter((f) => !(f.path === path && f.status === "refused")));

  const newFolder = (name: string) => setFolders((all) => [...new Set([...all, name])]);

  const botSaves = () => {
    const path = "reports/acme-renewal-notes.md";
    setFiles((all) => [
      ...all.filter((f) => f.path !== path),
      {
        path,
        sizeKb: 6,
        savedBy: "Planner",
        addedAt: "now",
        status: "ready",
        text: "# Acme renewal\n\nDana wants a 2-year term…",
      },
    ]);
    setItems((all) => [
      ...all,
      { kind: "bot", text: "I've written the renewal notes and kept them in your Knowledge." },
      { kind: "saved", path, by: "Planner" },
    ]);
  };

  const reset = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setFiles(seed);
    setFolders(["clients", "reports"]);
    setItems(seedItems);
    setAsk(null);
  };

  return {
    files,
    folders,
    items,
    ask,
    upload,
    scan,
    full,
    tooBig,
    replace,
    confirmReplace,
    cancelReplace: () => setAsk(null),
    remove,
    dismiss,
    newFolder,
    botSaves,
    reset,
  };
}

export type Stub = ReturnType<typeof useKnowledgeStub>;
