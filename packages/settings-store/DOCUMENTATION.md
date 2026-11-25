# Settings file store

[The store](src/index.ts) is the single settings-document reader/writer shared by
Electron and the Application Host. Instances for the same resolved path share
cached JSON text, never a mutable parsed object. `read()` and `readSync()` parse a
fresh object from cached text after checking file signatures. Each caller retains
its own default when neither the document nor the recovery copy exists.

Hot read-only consumers can use `store.createProjection(validate)`. The
projection validates only the fields the consumer needs and returns deeply
frozen plain data. Stable signatures reuse the same projection across sync and
async readers without parsing the document again. The original `read()` and
`readSync()` APIs still return fresh, editable objects, and `read({ cache: false })`
does not publish a snapshot. Projectors are synchronous and must not depend on
external mutable inputs such as credential stores.

Each read checks the identity, modification/change time and size of the document
and recovery copy. Directory watches are not a freshness barrier: notifications
can arrive after a completed external write, so no watcher or background timer is
retained. Unchanged signatures avoid rereading the document text; replacements,
writes, removals and newly created directories invalidate it. File corruption is
an error, not permission to overwrite it with defaults.

Mutations serialize in-process and acquire a cross-process lock. They always read
the current file under that lock instead of using the read cache. Successful
atomic replacement invalidates the old snapshot for all local instances; a failed replacement
does not publish the candidate. Transactions returning `write: false` do not
rewrite the document. The transient lock marker is not fsynced: it coordinates
live processes and is not recovery data. Windows replacement retains the previous
complete document until the replacement succeeds.

[Behavior tests](src/index.test.ts) cover independent instances, external writes,
same-turn external writes, immutable results, cached-text warm reads, process exit,
permissions and recovery.
