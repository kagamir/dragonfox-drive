# P3 — Encrypted Folder Tree (Design)

Status: approved 2026-06-24 · Scope: P3 subsystem #1 of 2 (folder tree). Link
sharing is a separate spec/cycle.

## Goal

Let users organize files into a nested folder hierarchy, with **folder names
AND the tree structure hidden from the server** (zero-trust, matching the
existing threat model in `docs/crypto-design.md`). This is the first half of
the P3 milestone; the second half (link sharing) gets its own spec.

## Confirmed decisions

1. **Tree structure is hidden from the server.** The server stores opaque
   folder rows; it cannot tell which folder is whose child. The client
   downloads every folder row, decrypts the parent pointers, and builds the
   tree in the browser.
2. **Hierarchical key wrapping (MEGA model).** Each folder has a random
   `folder_key`. A child's key (file_key or subfolder's folder_key) is wrapped
   by its parent folder's `folder_key`; root-level items' keys are wrapped by
   `master_key`. This keeps move operations cheap (one re-wrap) and makes a
   future "share folder" feature elegant (re-wrap one folder_key).
3. **Cascade HARD delete.** Deleting a folder irreversibly removes it and all
   descendants (rows + blobs). No trash UI in P3; a future "wipe" pass may
   purge other state. Standalone file delete is aligned to hard delete for
   consistency.
4. **Backend returns all folders; the frontend paginates client-side.** A
   direct consequence of (1): the server cannot list "children of X" because
   it cannot see structure, so it returns the whole set and the client filters.

## Non-goals

- Folder link sharing (deferred — likely P4+; depends on a resolution to the
  parent-pointer sharing trade-off noted in §1.5).
- Drag-and-drop move (a folder-picker modal is used instead).
- Trash / recycle-bin UI.
- Pagination on the wire (the client slices its in-memory tree).

---

## 1. Data model & crypto

### 1.1 Key hierarchy

```
master_key (32 B, client-only — root of trust)
    │ AES-GCM wrap
    ├─────────────────────────────────────────────┐
    ▼                                               ▼
┌──────────────┐   ┌───────────────────────┐   (root-level files)
│ root         │   │ root file_key         │     file_key wrapped by
│ folder_key   │   │ (existing model)      │     master_key — unchanged
└──────┬───────┘   └───────────────────────┘
       │ AES-GCM wrap of each child's key
       ├──────────┬──────────┬──────────┐
       ▼          ▼          ▼          ▼
   child folder_key / child file_key  (no depth limit)
       │
       ▼  (recursive)
```

**Rule:** every item's key (folder_key or file_key) is wrapped by its **parent
folder's** `folder_key`; **root** items (no parent) are wrapped by
`master_key`. This is fully backward-compatible — a root file behaves exactly
as today (file_key wrapped by master_key).

### 1.2 New `folders` table

```sql
CREATE TABLE folders (
    id                          TEXT PRIMARY KEY,        -- random uuid; opaque to structure
    owner_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Parent folder id, encrypted with master_key (so the client can bootstrap
    -- the tree shape WITHOUT needing the parent's folder_key). NULL ≡ root.
    encrypted_parent_id         TEXT,                    -- base64 AES-GCM(master_key, parent_id)
    encrypted_parent_id_nonce   TEXT,
    -- This folder's folder_key, wrapped by the PARENT's folder_key
    -- (or by master_key when encrypted_parent_id is NULL / root).
    encrypted_folder_key        TEXT NOT NULL,           -- base64
    encrypted_folder_key_nonce  TEXT NOT NULL,           -- base64
    -- Folder name, encrypted with THIS folder's own folder_key.
    encrypted_name              TEXT NOT NULL,           -- base64
    encrypted_name_nonce        TEXT NOT NULL,           -- base64
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_folders_owner ON folders(owner_id);
```

**Naming symmetry with `files`:** `files.encrypted_file_key` ↔
`folders.encrypted_folder_key`. Each table is internally consistent; `files`
columns are unchanged.

### 1.3 `files` table additions

```sql
ALTER TABLE files ADD COLUMN encrypted_parent_id       TEXT;  -- base64 AES-GCM(master_key, parent_folder_id); NULL ≡ root
ALTER TABLE files ADD COLUMN encrypted_parent_id_nonce TEXT;
```

- `encrypted_file_key`'s **meaning** is refined: a root file (parent NULL) is
  still wrapped by `master_key` (**zero migration of existing data**); a file
  inside a folder is wrapped by that folder's `folder_key`.
- Chunking, streaming, manifest encryption are **unchanged** — `file_key`
  still encrypts manifest + chunks. The SW streaming path, upload, and
  download need no crypto changes.

### 1.4 Why `encrypted_parent_id` uses `master_key` (not `folder_key`)

To decrypt a folder's parent_id using that folder's own folder_key, the client
would first need the folder_key — which is wrapped by the parent's folder_key
— requiring the parent — which is what we are trying to recover. That cycle
cannot be broken.

Instead, parent pointers are encrypted with `master_key`, decoupling
structure recovery from the key graph:

1. Decrypt **every** row's `encrypted_parent_id` with `master_key` → full tree
   shape (a forest) is known immediately.
2. Walk from the roots: unwrap each root's `encrypted_folder_key` with
   `master_key` → `folder_key` → decrypt name. For each child whose parent is
   this folder: unwrap the child's key with THIS folder's `folder_key`, and
   recurse.
3. Cache the decrypted tree in the Pinia store.

### 1.5 Known trade-off (deferred to folder-sharing work)

Because parent pointers are encrypted with `master_key`, a future share
recipient (who has only a `share_key`, never `master_key`) cannot decrypt the
structure of a shared subtree by themselves. This is acceptable for P3 (no
folder sharing). When folder sharing arrives, the options are:

- re-encrypt the shared subtree's parent pointers under the `share_key` at
  share-creation time, or
- switch to "encrypted children list embedded in each folder's metadata"
  (full MEGA-style), or
- have the owner enumerate descendant ids at share time (reveals grouping but
  not shape, since ids are opaque).

This spec does not choose among them.

### 1.6 Orphan recovery (safety net)

When the client builds the tree, any item (folder or file) whose decrypted
`parent_id` refers to a folder id that is **not present** in the folder set is
treated as **root-level**. This prevents data from becoming invisible if a
cascade delete ever omits a descendant (e.g. a client bug or a race): the
orphan resurfaces at the top level instead of being silently lost.

---

## 2. Server API

All endpoints require `Authorization: Bearer <access_token>` and enforce
owner-scoping (non-owner → `404`, matching the existing convention).

| Method & path               | Purpose                                                      |
|-----------------------------|--------------------------------------------------------------|
| `GET /api/folders`          | Return ALL of the caller's folder rows (encrypted).          |
| `POST /api/folders`         | Create a folder.                                             |
| `PATCH /api/folders/:id`    | Rename and/or move (re-wrap key + new parent).               |
| `DELETE /api/folders/:id`   | Hard cascade delete (body lists descendant ids).             |
| `PATCH /api/files/:id`      | Move a file (new parent + re-wrapped file_key).              |
| `GET /api/files`            | Existing; `FileMeta` gains `encrypted_parent_id(+nonce)`.    |

Filtering by parent is **client-side** (the server cannot see structure).

### 2.1 `POST /api/folders`

Request:
```json
{
  "encrypted_parent_id": "<base64|null>",
  "encrypted_parent_id_nonce": "<base64|null>",
  "encrypted_folder_key": "<base64>",
  "encrypted_folder_key_nonce": "<base64>",
  "encrypted_name": "<base64>",
  "encrypted_name_nonce": "<base64>"
}
```
The server generates the `id` (uuid), inserts the row, and responds
`200 { "id": "<uuid>" }` — matching the existing `POST /api/files` pattern.

### 2.2 `GET /api/folders`

Response:
```json
{ "folders": [ {
  "id": "<uuid>",
  "encrypted_parent_id": "<base64|null>",
  "encrypted_parent_id_nonce": "<base64|null>",
  "encrypted_folder_key": "<base64>",
  "encrypted_folder_key_nonce": "<base64>",
  "encrypted_name": "<base64>",
  "encrypted_name_nonce": "<base64>",
  "created_at": "<rfc3339>",
  "updated_at": "<rfc3339>"
} ] }
```
Returns every folder owned by the caller. The client decrypts and filters.

### 2.3 `PATCH /api/folders/:id`

All fields optional. A move supplies parent + folder_key together; a rename
supplies only the name.
```json
{
  "encrypted_name": "<base64>", "encrypted_name_nonce": "<base64>",
  "encrypted_parent_id": "<base64|null>", "encrypted_parent_id_nonce": "<base64|null>",
  "encrypted_folder_key": "<base64>", "encrypted_folder_key_nonce": "<base64>"
}
```
Responds `200 { "ok": true }`. `404` if `:id` is unknown or not owned by the
caller.

### 2.4 `DELETE /api/folders/:id` (hard cascade)

Because structure is hidden, the server cannot locate descendants itself. The
client enumerates them from its decrypted tree.

Request body:
```json
{
  "folder_ids": ["<target uuid>", "...all descendant folder uuids"],
  "file_ids":   ["...all descendant file uuids"]
}
```
The server, in a single transaction:

1. Verifies **every** listed id belongs to the caller (any mismatch → `404`
   and the whole transaction is abandoned — `404` rather than `403` to match
   the project's hide-existence convention used by `files.rs`).
2. `DELETE FROM folders WHERE id IN folder_ids AND owner_id = caller`.
3. `DELETE FROM files   WHERE id IN file_ids   AND owner_id = caller`.
4. Removes the on-disk blobs for every `file_id` (reuses
   `storage::delete_file_chunks`).
5. Responds `200 { "ok": true, "deleted_folders": <n>, "deleted_files": <m> }`.

Hard delete — rows are removed, not flagged. The target folder's id MUST be
present in `folder_ids`.

### 2.5 `PATCH /api/files/:id` (move file)

```json
{
  "encrypted_parent_id": "<base64|null>",
  "encrypted_parent_id_nonce": "<base64|null>",
  "encrypted_file_key": "<base64>",
  "encrypted_file_key_nonce": "<base64>"
}
```
Updates the file's parent and the wrap of its `file_key`. `200 { "ok": true }`
or `404`.

### 2.6 `GET /api/files` (unchanged shape, two new fields)

`FileMeta` gains `encrypted_parent_id` and `encrypted_parent_id_nonce`. The
existing list refresh flow is otherwise unchanged.

### 2.7 Standalone `DELETE /api/files/:id` — now hard delete

Aligned with folder cascade delete: the handler removes the row (no
`status='deleted'`) and deletes the blobs. The existing soft-delete test is
replaced by a hard-delete test.

---

## 3. Operation flows (exact crypto steps)

### 3.1 Create folder (inside parent `P`, or at root)

1. Client: `folderKey = random32()`; `encrypt(name, folderKey)` → name;
   `wrap(folderKey, P.folderKey or masterKey)` → folder_key;
   `encrypt(P.id | null, masterKey)` → parent_id.
2. `POST /api/folders`; server returns `id`.
3. Client inserts the node (with the fields it just computed) into its local
   decrypted tree.

### 3.2 Upload a file into a folder

The existing `stores/files.ts:upload` changes in exactly two places:

- wrap `fileKey` with the **current folder's** `folder_key` (root →
  `master_key`; behavior unchanged for root), and
- set `encrypted_parent_id = encrypt(currentFolderId, masterKey)`.

Chunking, streaming, and the manifest are untouched.

### 3.3 Rename folder

Re-encrypt the name with the **existing** `folder_key` and `PATCH
encrypted_name(+nonce)`. The folder_key does not change.

### 3.4 Move (folder or file → new parent)

1. **Cycle check:** if the item is a folder, the client DFS-walks its
   decrypted subtree and rejects the move if `newParent` is the item itself or
   any of its descendants.
2. Re-wrap the item's key (`folder_key` / `file_key`) with `newParent`'s
   `folder_key` (root → `master_key`).
3. Re-encrypt `parent_id` (= `newParent.id` or null) with `master_key`.
4. `PATCH` the appropriate endpoint.
5. **Descendants are untouched** — their wraps are by the moved item's
   *unchanged* internal key; only the moved item's own wrap by its parent
   changes.

### 3.5 Delete folder (hard cascade)

1. Client DFS-computes the full descendant set from its decrypted tree.
2. `DELETE /api/folders/:id` with `folder_ids` + `file_ids`.
3. Server transaction (§2.4) hard-deletes rows + blobs.
4. Client removes the subtree from its local tree.

---

## 4. Frontend

### 4.1 Store split

To keep `stores/files.ts` focused, a new store holds the structure:

- **`stores/folders.ts` (new):** holds the decrypted folder tree, navigation
  state, folder CRUD, and client-side pagination.
- **`stores/files.ts` (changed):** keeps upload/download/preview; reads
  `currentFolderId` from the folders store to choose the wrap key and parent;
  gains a `moveFile` action.

### 4.2 `stores/folders.ts` shape

```ts
interface FolderNode {
  id: string;
  parentId: string | null;   // decrypted
  folderKey: Uint8Array;     // decrypted
  name: string;              // decrypted
  createdAt: string;
}
// state:  currentFolderId (null = root), page, pageSize (=50)
// computed:
//   breadcrumbs        — root → current path
//   childrenFolders    — folders whose parentId == currentFolderId
//   filesInCurrent     — from files store, same parent filter
//   paginatedView      — (folders first, then files, each name-sorted),
//                        sliced by [page*pageSize, (page+1)*pageSize)
```

- `loadTree()`: `GET /api/folders` → decrypt all parent_ids with master_key →
  BFS from roots unwrapping the folder_key chain and decrypting names → cache.
- Client-side pagination: the store holds everything; the view slices by page.
  Changing pages is instant (no request).

### 4.3 `DriveView.vue` changes

- Breadcrumb bar at top (`Drive / Photos / 2026`), each segment clickable.
- Mixed list: sub-folders first (📁 icon + name), then files in the current
  folder.
- Toolbar: **New folder** button (prompts for a name).
- Per-folder row actions: Open (navigate in) / Rename / Move / Delete.
- Per-file row actions: existing Open / Download / Delete + **Move**.
- Upload dropzone targets `currentFolderId` (root → unchanged behavior).

### 4.4 Move UX — `components/MovePickerModal.vue` (new)

A modal that renders the folder tree as collapsible nodes plus a "Move to
root" button. The user picks a destination; the client runs the cycle check,
re-wraps, and PATCHes. Drag-and-drop is explicitly out of scope for P3.

### 4.5 Local update strategy

Mutations (create / rename / move / delete) update the local tree from the
operation's known result for snappy feedback. A full `loadTree()` runs only on
initial mount and after sign-in.

---

## 5. Migration & testing

### 5.1 Migration

New file `server/migrations/20260101000003_folders.sql` containing the
`CREATE TABLE folders` + index + the two `ALTER TABLE files` statements from
§1.2–§1.3. Existing files get NULL `encrypted_parent_id` (root) — zero data
migration.

`server/src/models.rs` gains a `FolderRow` struct (`sqlx::FromRow`); `FileRow`
and `files::FileMeta` gain the two `encrypted_parent_id` columns.

### 5.2 Testing (TDD, matches the project's dense in-module unit-test style)

**Rust (`#[tokio::test]`, inline — mirrors `files.rs`):**
- `folders.rs`: create inserts a row; `list` returns only the caller's folders;
  `patch` rename updates only name fields; `patch` move updates parent +
  folder_key;   `delete` cascade removes exactly the listed rows + their blobs
  and enforces ownership (non-owner → `404`); hard delete leaves no row.
- `files.rs`: replace the existing soft-delete test with a **hard-delete**
  test (row gone, blobs gone); `patch` move updates parent + file_key;
  `GET /api/files` list carries the two new columns (extend the existing
  round-trip tests).

**Frontend (Vitest, mirrors existing `*.test.ts`):**
- `crypto/folder.ts` (new): pure-function tests for folder_key chain wrap /
  unwrap, name encrypt/decrypt, parent_id encrypt/decrypt — including the
  root-wrap-by-master_key case and a multi-level chain.
- `stores/folders.test.ts`: `loadTree` decrypts shape + keys; **cycle
  detection** rejects moving a folder into its own descendant; **orphan →
  root**; pagination slices correctly.
- `api/folders.ts` + `api/types.ts` types.

**Crypto worker:** add `wrapFolderKey`, `unwrapFolderKey`, `encryptName`,
`decryptName`, `encryptParentId`, `decryptParentId` to the Comlink API (off
the main thread, consistent with existing offloading).

### 5.3 Files touched

- **Server:** new `migrations/20260101000003_folders.sql`; new
  `src/api/folders.rs`; `src/api/mod.rs` (routes); `src/models.rs`;
  `src/api/files.rs` (hard delete + patch-move + new columns).
- **Frontend:** new `src/api/folders.ts`; new `src/crypto/folder.ts`;
  `src/api/types.ts`; `src/workers/crypto.worker.ts` + `crypto.ts`; new
  `src/stores/folders.ts`; `src/stores/files.ts`; `src/views/DriveView.vue`;
  new `src/components/MovePickerModal.vue`.
- **Docs:** `docs/crypto-design.md` (folder key hierarchy §); `docs/api.md`
  (folder endpoints); `README.md` (P3 status row).
- `AGENTS.md` commands table is unchanged.

---

## Open question for the plan phase

The order in which to build (crypto helpers → server → store → UI vs. a
vertical slice) is a plan-phase decision and is intentionally left open here.
