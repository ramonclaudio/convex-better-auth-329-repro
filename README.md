# convex-better-auth #329 repro

Hit a bug where Convex queries threw `Invalid session ID` every time a Better Auth session rotated (`changePassword({ revokeOtherSessions: true })`, cross-domain handoff, custom plugin endpoints). The provider's `fetchAccessToken` was holding onto the JWT bound to the deleted session. Filed [`get-convex/better-auth#329`](https://github.com/get-convex/better-auth/pull/329) to fix it. This repo is the minimal repro so maintainers and reviewers don't have to spend time recreating one to validate the PR.

## Run

You need Bun. Node + npm works if you swap the commands.

```bash
bun install
bun run test:bug             # released 0.12.2, no patch
bun run test:329             # the original PR attempt (useEffect-based)
bun run test:ref-fix         # the working fix (in-fetcher detection)
bun run test:ref-fix-render  # alternative using during-render reset
```

Each script swaps a build of `node_modules/@convex-dev/better-auth/dist/react/index.js` into place and runs the same vitest suite. The variants live in `patches/`.

## Results

| Test | pristine | `useEffect` (original PR) | **in-fetcher + ref** |
|---|---|---|---|
| rotation A → B: cached fetcher returns new JWT | FAIL | FAIL | PASS |
| forceRefreshToken=true always mints fresh | pass | pass | pass |
| logout (sessionId → null) clears cached JWT | FAIL | FAIL | PASS |
| cold-start sign-in: no spurious cache thrash | pass | pass | pass |
| SSR hydration: initialToken short-circuits without fetch | pass | pass | pass |
| rapid rotation A → B → C: cache drops at each step | FAIL | FAIL | PASS |
| rotation while fetch in flight: pending dropped, fresh fetch | FAIL | pass | pass |
| setAuth-style call on rotation: child effect reads new JWT | FAIL | FAIL | PASS |
| late-resolving stale token() must not overwrite fresh cache | FAIL | FAIL | PASS |
| **Total** | **3 / 9** | **4 / 9** | **9 / 9** |

## What's in `patches/`

| File | What it represents |
|---|---|
| `pristine.js` | released `@convex-dev/better-auth@0.12.2`, no patch |
| `329-rays-fix.js` | the original `useEffect`-based attempt on PR #329 |
| `ref-fix.js` | rotation detected in the fetcher's synchronous prelude, plus a `cachedTokenRef` and a late-resolve guard. The shape the PR ships. |
| `ref-fix-render.js` | works but logs `Cannot update a component while rendering a different component`. Kept for comparison. |

The mocked `convex/react` includes a child component that calls `fetcher({forceRefreshToken: false})` from `useEffect([fetcher])`, mirroring Convex's real `ConvexAuthStateFirstEffect`. That's the path the bug fires on, and it's why a `useEffect`-based cleanup in the parent can't beat it (React fires child effects before parent effects).

## Verify the bug

```bash
bun run test:bug
```

6 of 9 fail against released `0.12.2`. Run `bun run test:ref-fix` to see all 9 pass with the fix.

## License

MIT.
