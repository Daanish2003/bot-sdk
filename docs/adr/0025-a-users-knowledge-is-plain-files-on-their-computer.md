---
Status: accepted
---

# A user's Knowledge is plain files on their Computer

The lecture says "What the agent knows lives in files" (slides 10, 11), and the agent finds things with shell commands over those files [9:11, 34:14]. So a user's Knowledge is plain files in `/home/user/shared/knowledge/` on their Computer, in folders of their own choosing, and the files are the source of truth. There are no rows, no embeddings and no search index. This supersedes ADR 0014, and ADR 0012 with it (its Synced sources were never built).

- **Shared by all of the user's Bots.** The lecture settles sharing only for memory (slide 35). Knowledge is documents about the user's world, not one Bot's, so it sits in the `shared` tree that step 5 already syncs. The user writes through the UI, and any of their Bots with its ordinary `write` and `edit` tools (slide 11: "you and the agent can both read, search and edit it"). Memory is facts a Bot picks up; Knowledge is documents kept for reference.
- **Converted at upload.** The server converts a PDF or DOCX with the parsers ported from Sim (ADR 0014's `extract.ts`, which keeps its notice) and writes `<name>.md` beside the original, PDFs with page markers. Markdown, text, HTML and CSV are stored as they are. A PDF with no text layer is refused; there is no OCR. Uploads are capped at 20 MB, converted text at 2 MB, and all of Knowledge at 50 MB, below the sync's 100 MB.
- **Straight to the Computer.** An upload wakes the Computer and writes both files, as Memory editing does. Nothing is staged elsewhere.
- **Found on demand.** A Knowledge block in the Prompt start names the folder and lists the readable paths, capped at 4,000 characters, with changes arriving as Change notes. The Bot reads with the existing `list`, `read` and shell `grep`/`find`, and cites the file and page in plain text. The block says Knowledge is information, not instructions, and Knowledge never counts as the user's permission.
- **Where the code lives.** A `knowledge` plugin that `uses: ["computer"]`. Without it, or without a Computer, there is no Knowledge.

The assistant's Project Knowledge (its tables, blobs, `vector` extension, search tool, Excerpts and all embedding support) is removed in the same step, with no export.

## Considered Options

- **Keep hybrid search as a tool beside the files** (the build order's first wording): better recall for paraphrased questions, but a second copy to keep in step with files the Bots edit freely, and the lecture never mentions an index. Shipped coding agents have moved the same way (Cursor dropped its embedding index in July 2026).
- **Per-Bot Knowledge** (`/home/user/bots/<botId>/knowledge/`, like Memory and Skills): clear ownership, but the user uploads the same handbook once per Bot.
- **Convert on the Computer** (`poppler-utils` in the template): Bots could also read PDFs they fetch, but every Computer rebuilds, it covers PDF only, and failures show later.

## Consequences

- Questions worded differently from the text, with no shared keyword, are grep's weak spot. The evals score this case without gating on it.
- Uploading wakes the Computer.
- A Knowledge file a Bot saved from the web can carry injected text; the trust label and step 9's automatic review are the defence.
- A rebuild restores Knowledge only as of the last sync.
