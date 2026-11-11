---
name: phase-check
description: Verify whether a build phase from PROJECT_BRIEF.md section 7 is really done, and report evidence for each criterion. Use when the developer runs /phase-check, asks "is phase N done", or before starting the next phase or moving to the client's store.
argument-hint: "[phase number, default: current phase]"
---

# Phase check

Goal: an honest answer to "is this phase finished?", with evidence, before the next phase builds on it.

## Steps

1. Read `PROJECT_BRIEF.md` section 7. Take the phase from the argument; if none, work out the earliest phase whose "Done when" is not yet met and check that one.
2. List that phase's bullet points and its "Done when" line as individual criteria. Add the Phase 8 checklist items that apply to it.
3. For each criterion, find evidence and classify it:
   - **Verified**: you ran something in this session and saw it pass (test, typecheck, a script against the local database). Quote the command and the relevant output line.
   - **Implemented, not verified**: the code exists but nothing proves it works.
   - **Needs the developer**: it can only be confirmed in a browser, the Shopify admin, the Partner/Dev Dashboard, or with a physical phone scan. Give click-by-click steps. Never log in or enter credentials yourself.
   - **Missing**.
4. Run the project gates and report the real results:
   - `npm run typecheck`
   - `npm run lint`
   - the test command, if the project has one. If there are no tests for this phase's logic, say so as a gap; do not write them unless asked.
5. Run the `ring-invariant-reviewer` agent on the phase's changes if the phase touched rings, webhooks, QR or write-back code, and include its findings.
6. Check section 6 of the brief: name any open item that blocks the next phase.

## Report format

Reply in Bangla (code, commands and file names in English). Lead with the verdict in one line: done, not done, or done except for developer checks. Then a table: criterion, status, evidence. Then the blocking open items. Nothing else.

A phase is "done" only when every criterion is Verified or confirmed by the developer. Code that exists is not a finished phase.

## Extra gate before Phase 9 (client's store)

All of Phase 8 confirmed on the dev store, plus:

- `VAULT_BASE_URL` is the final production domain, confirmed by the client in writing
- the ring ID alphabet is confirmed with the Vault developer
- `distribution` in `app/shopify.server.ts` matches custom distribution
- access tokens are encrypted at rest
- the production database is not SQLite, and has the unique index on `(lineItemId, unitIndex)`
- no template demo leftovers remain in `shopify.app.toml` (demo metafield, metaobject, product event subscription, unused scopes)
- no handler logs webhook payloads
