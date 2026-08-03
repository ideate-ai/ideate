# Transport contract — one store, two transports, different process lifetimes

A contributor doc. This is the contract the CLI/MCP transport split is governed
by, reconciled against the shipped code (every claim carries a file:line anchor).
It exists because the split produced four defects in one arc, each a different
bug class, escalating from a documentation gap to silent data loss — and
"remember to grep harder" did not catch the third and cannot catch the fourth.

The mechanical guard for the record store's freshness guarantee lives in
`src/record/transport-parity.test.ts` (cross-transport) and
`src/record/store.test.ts:987` (cross-instance). The steering rule that names
the fault line is P-40 (sibling-surface parity, extended across transports).

## The invariant

A store exposed through two transports of different process lifetimes is a
fault line in **two** distinct ways. For any proposed change to such a store,
answer both questions:

> **(A) STALENESS.** Does the change add, remove, or rely on read-path state
> held across calls (a memo, a cached directory listing, an opened connection,
> a generation counter)? If it does, that state is populated by one
> transport's view and reused for the other's. A write through the
> short-lived transport (the CLI, one fresh process per invocation) is then
> invisible to the long-lived transport (the MCP server, one store held for
> the whole session) **until the state is refreshed**. A cross-call cache is
> safe ONLY under one of these:
> - the cached data is **immutable under all writers** (the record store: a
>   record file is append-only, exclusive `wx` create, never edited — so
>   `parsedById`/`referrers` are permanent and never stale); OR
> - the cached data is **refreshed by a freshness signal that reflects ALL
>   writers, not the instance's own `append()` alone** (a generation counter
>   bumped only on the instance's own write is NOT such a signal — that was
>   occurrence 4); OR
> - the read **re-reads the live source** for the mutable part each call (the
>   record store re-lists the directory tree every `readViews` call, so a
>   file written by another process is seen on the very next call).
>
> If a cache holds mutable data and none of the three holds, the change is a
> correctness regression waiting to ship silent incomplete reads to consumers
> whose conclusions are universally quantified over the store.
>
> **(B) DISCOVERY.** Does the change alter the store's read or write contract
> (paging, envelope shape, freshness, what a write must state)? If it does,
> the change reaches every consumer only if it sweeps **both transports'
> consumers**: the MCP verb names, the CLI bin names, AND the agent/skill
> prose that instructs an agent to call the bin. Grepping one transport's
> symbols **structurally cannot** find the other's consumers (occurrence 1:
> the sweep searched MCP verb names and missed five agent prompts that reach
> the store through `bin/ideate-record`). And a mechanism whose effect
> depends on process lifetime (a per-instance memo) reaches **exactly one**
> transport (occurrence 3) — discover this by stating, for the change, which
> transports it reaches and why.

A reviewer applying this to a proposed change gets a determinate answer: both
questions are yes/no, and a "yes" on (A) without one of the three safety
conditions, or a "yes" on (B) without a sweep of both transports' consumers, is
the fault line.

## The three stores, as shipped

| Store | Transports (read / write) | Process lifetime | Cross-call cached read state | Freshness guarantee |
|---|---|---|---|---|
| **record** (`src/record/store.ts`) | MCP `record_read` / `record_append`·`record_decision`; CLI `bin/ideate-record read`·`append`; in-process assembler | MCP: one store per session (`src/record/tools.ts:258-278`, lazily built, reused); CLI: fresh store per invocation (`src/cli/ideate-record.ts:225-235`, called at every entry point) | **Yes — `#walkCache`** (`store.ts:318`): `parsedById` + `referrers`, permanent, never invalidated | **Immutable-contents + re-listed directory.** File contents are cached permanently (records are append-only, `store.ts:220-228`); the directory listing is re-read on every call (`store.ts:200-217`, `#idsNewestFirst`), so a record written by another process is visible on the very next call. Safe because the cached part is immutable and the mutable part (the listing) is never cached. |
| **board / work-state** (`src/work-state/store.ts`) | MCP `work_list`·`work_get`·`work_create`·`work_claim`·`work_complete`·…; CLI `bin/ideate-work list`·`create`·… | MCP: one store/verbs per session (`src/work-state/tools.ts:340-360`); CLI: fresh per invocation (`src/cli/ideate-work.ts:241-255`, every entry point) | **No.** `WorkStateStore`'s only instance fields are `#dbPath`/`#clock`/`#nextId`/`#resolveId` (`store.ts:974-994`); every read opens a FRESH SQLite connection (`openForRead`, `store.ts:1100+`) and closes it. | **Live query every read.** SQLite handles cross-process concurrency; a write through either transport is visible to the next read through either. The staleness fault line (A) does NOT apply. The discovery fault line (B) DOES — agents read the board through `bin/ideate-work list`. |
| **steering** (`src/steering/store.ts`) | MCP `steering_read` / `steering_put` (writes are MCP-only — there is NO `bin/ideate-steering`); in-process assembler reads | MCP: per session; assembler: in-process | **No** — "Read steering items straight off the files — no index, no cache" (`steering/store.ts:391-409`) | **Re-reads files every call.** Single transport for writes, so the two-transport fault line does not apply. **Items are MUTABLE** (amendable via `steering_put`), so the record store's "cache contents, never the listing" split does NOT transfer: a steering contents-memo keyed by id would go stale the moment any process amends that item, a premise the record store's immutability does not provide (`steering/store.ts:402-409`). |

## What a change to a shared store must state

When you change a store that has two transports (today: the record store and
the board store), the PR/commit must state:

1. **Reach.** Which transports does the change touch, and which does it not?
   Name both the MCP verb and the CLI bin. If the change affects only one,
   say why the other is unaffected (and confirm it by running both doors).
2. **Cross-call state.** Did you add or change any read-path state held across
   calls? If yes, which of the three safety conditions (immutable-under-all-
   writers / all-writer freshness signal / re-read the live source) keeps it
   correct? If none — stop; that is occurrence 4.
3. **The guard.** Where is the mechanical guard that the store's guarantee
   holds through BOTH transports? If it exists for one transport only, add it
   for the sibling in the SAME change (P-40). The record store's freshness
   guard is `transport-parity.test.ts` (cross-transport) + `store.test.ts:987`
   (cross-instance).
4. **Prose sweep.** If the change alters the read/write contract, did you
   sweep both transports' consumers — the MCP verb names, the CLI bin names,
   and the agent/skill prose that calls the bin? (P-46.)

## The four occurrences — traceable from this artifact

1. **Prose sweep missed the CLI consumers** — a bounded-read release updated
   every skill consuming the newly-paged MCP reads; five agent prompts reached
   the same store through `bin/ideate-record` and were missed because the
   greps searched MCP verb names. Recorded lesson at the time: "grep the
   binary names too." Insufficient — it is a DISCOVERY (B) failure, and
   occurrence 3 is undiscoverable by grep. → This contract's §(B) + P-46.
2. **Paging judgement made twice** — the per-agent "which agents page to
   exhaustion" decision had to be reasoned separately for the CLI consumers
   because the MCP-side prose did not reach them. Same DISCOVERY (B) shape.
   → This contract's §(B) + P-46.
3. **A performance fix reached only the long-lived process** — the in-process
   walk-memo (`01KYV3PN6P`) made the walk linear for the MCP path (one store
   per session) and did nothing for the CLI path (fresh store per
   invocation), which is how the agents reach the record. The mechanism is
   process-lifetime-dependent, so no grep could have found it. Finding
   `01KYWCCCNTACC96YD7NSP7NVBA`; the CLI side is now addressed by the
   ephemeral walk snapshot (`src/cli/record-walk-snapshot.ts`, item
   `01KYXRKJT6`). → This contract's §(A)/(B) reach statement; P-40
   transport-sibling parity.
4. **The same memo became a correctness regression** — a cached directory
   listing invalidated only by the instance's own `append()` made a warm MCP
   session silently stop seeing records written by the CLI transport for the
   rest of the session, returning incomplete pages without throwing to
   consumers whose conclusions are universally quantified over the record.
   Finding `01KYWCRF6894TK8VF5QXEXRZ5K`. FIXED by the listing/contents split
   (`store.ts:197-228`: listing never cached, contents cached because
   immutable) and pinned by `store.test.ts:987` (cross-instance) +
   `transport-parity.test.ts` (cross-transport). → This contract's §(A);
   P-40.

A fifth occurrence is recognised by running the two questions above against the
proposed change: a "yes" on (A) without a safety condition, or a "yes" on (B)
without a both-transport sweep, is the same fault line.