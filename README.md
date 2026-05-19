# convex-better-auth #329 repro

Hit a bug where Convex queries threw `Invalid session ID` every time a Better Auth session rotated (`changePassword({ revokeOtherSessions: true })`, cross-domain handoff, custom plugin endpoints). The provider's `fetchAccessToken` was holding onto the JWT bound to the deleted session. Filed [`get-convex/better-auth#329`](https://github.com/get-convex/better-auth/pull/329) to fix it. This repo is the minimal repro so maintainers and reviewers don't have to spend time recreating one to validate the PR.

## Run

You need Bun. Node + npm works if you swap the commands.

```bash
bun install
bun run test:bug     # released 0.12.2
bun run test:fix     # patched
```

Each script swaps a build of `node_modules/@convex-dev/better-auth/dist/react/index.js` into place and runs the same vitest suite. The two variants live in `patches/`.

## Results

| Test | pristine | patched |
|---|---|---|
| rotation A → B: cached fetcher returns new JWT | FAIL | PASS |
| forceRefreshToken=true always mints fresh | pass | pass |
| logout (sessionId → null) clears cached JWT | FAIL | PASS |
| cold-start sign-in: no spurious cache thrash | pass | pass |
| SSR hydration: initialToken short-circuits without fetch | pass | pass |
| rapid rotation A → B → C: cache drops at each step | FAIL | PASS |
| rotation while fetch in flight: pending dropped, fresh fetch | FAIL | PASS |
| setAuth-style call on rotation: child effect reads new JWT | FAIL | PASS |
| late-resolving stale token() must not overwrite fresh cache | FAIL | PASS |
| **Total** | **3 / 9** | **9 / 9** |

The mocked `convex/react` includes a child component that calls `fetcher({forceRefreshToken: false})` from `useEffect([fetcher])`, mirroring Convex's real `ConvexAuthStateFirstEffect`. That's the path the bug fires on.

## License

MIT.
