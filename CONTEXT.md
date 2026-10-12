# ai-chat

A personal ChatGPT-style chat app: signed-in users talk to LLMs and keep their history.

## Language

**Chat SDK**:
The reusable chat feature (Conversations, runs, settings, Shared links) a Host embeds. It knows users only by id.
_Avoid_: Library, package, chat module

**Host**:
An app that embeds the Chat SDK and supplies its users, its routes and a Postgres database. The web app in this repo is one Host.
_Avoid_: Consumer, client app, integrator

**Conversation**:
One chat thread owned by a single user, listed in the sidebar. A user can pin it to the top of the sidebar.
_Avoid_: Chat, thread, session

**Project**:
A named group of a user's Conversations that share context: instructions and a default Model. A Conversation is in at most one Project; deleting the Project deletes its Conversations.
_Avoid_: Folder, workspace, collection

**Instructions**:
Text a user or Project gives the assistant to shape every reply. A user's apply to all their Conversations, a Project's only to its Conversations, and both apply together.
_Avoid_: System prompt, custom instructions, persona

**Message**:
One turn in a Conversation, authored by either the user or the assistant.
_Avoid_: Turn, reply, prompt

**Run**:
The generation of one assistant Message, from the moment it's sent until it ends `complete`, `stopped`, `error` or waiting for an Approval. It goes on without a reader, and anyone can join it while it's live.
_Avoid_: Job, generation, stream

**Branch**:
One path through a Conversation's tree of Messages, created when a Message is edited or regenerated.
_Avoid_: Fork, version, variant

**Active Branch**:
The one Branch of a Conversation that is currently shown and that the next Message continues. Switching to a sibling makes its newest Branch active.
_Avoid_: Current branch, selected path

**Provider**:
An LLM vendor a user can chat through, one per TanStack AI chat adapter (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, …).
_Avoid_: Vendor, backend

**Model**:
One specific LLM offered by a Provider. A Conversation has a selected Model, and each assistant Message records the Model that wrote it.
_Avoid_: Engine, LLM (as a noun for one choice)

**Provider credentials**:
What one user supplies to reach one Provider: usually an API key, sometimes with an account or region, or just a host for a local Provider. When a user has them for a Provider, their runs on it always use them and never count against their Quota.
_Avoid_: Provider key, API key (ambiguous), token, BYOK key

**Host credentials**:
Provider or Tool credentials the Host supplies for all its users, with the Models it offers on them. Runs on them count against the user's Quota.
_Avoid_: Server key, free tier key, platform key

**Quota**:
How much a user may spend on Host credentials per window (a day or a month), set by the Host per user. It is measured in money, and unlimited when the Host sets none.
_Avoid_: Limit, allowance, credits, free tier

**Tool credential**:
A user's own API key for a non-LLM service a tool needs, such as web search. Without it, that tool is unavailable to the user.
_Avoid_: Search key, Provider credentials (those are for Providers only)

**Connection**:
A user's authorisation to use one of the MCP servers the Host offers, made by signing in to that server. The user switches each Connection on per Conversation.
_Avoid_: Integration, MCP credential, Tool credential (that is an API key)

**Approval**:
A user's yes or no to one tool call before it runs. While a call waits for it, the Run has ended; approving starts a new Run that carries on from the call.
_Avoid_: Confirmation, consent, permission

**Source**:
A web page a web search returned, or a page the `fetch_url` tool read, during an assistant Message, numbered within that Message and shown as a chip under the search or fetch and wherever the reply cites it.
_Avoid_: Citation (that is the chip in the text pointing at a Source), result, reference

**Shared link**:
A public, read-only snapshot of a Conversation's Active Branch taken at the moment it is shared. A Conversation has at most one; sharing again moves it to the current Active Branch under the same link. It disappears when its Conversation is deleted.
_Avoid_: Share, public chat, permalink

**Attachment**:
A file (image, PDF or text file) a user uploads and attaches to their Message. It is never copied: editing a Message carries its Attachments over to the new Branch, where the user can remove some or add more; regenerating a reply leaves them as they were. A Shared link shows only each Attachment's file name and type.
_Avoid_: Upload, file part, document
