# convex-better-auth-329-repro

Convex queries throw `Invalid session ID` whenever a Better Auth session rotates (`changePassword({ revokeOtherSessions: true })`, cross-domain handoff, custom plugin endpoints that call `setSessionCookie`). The provider's `fetchAccessToken` holds onto the JWT bound to the deleted session. Filed [`get-convex/better-auth#329`](https://github.com/get-convex/better-auth/pull/329) to fix the React-layer state machine.

This repo is the vitest suite. Proves the React-layer fix works in isolation by mocking `convex/react` and driving the fetcher through session-id rotations directly.

## Run

You need Node 22+.

```bash
npm install
npm run test:bug    # released 0.12.2 (vanilla)
npm run test:fix    # patched (PR #329)
```

Each script swaps `node_modules/@convex-dev/better-auth/dist/react/index.js` and runs the same vitest suite. The two variants live in `patches/`.

## What you'll see

| Test | vanilla | patched |
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

## Related

- [Unit tests](https://github.com/ramonclaudio/convex-better-auth-329-repro) (this repo, vitest + mocked React)
- [Expo](https://github.com/ramonclaudio/convex-better-auth-329-expo-repro) (real iOS + Convex + Better Auth)
- [TanStack](https://github.com/ramonclaudio/convex-better-auth-329-tanstack-repro) (real browser + Convex + Better Auth)

Upstream PRs and issues:
- [get-convex/better-auth#329](https://github.com/get-convex/better-auth/pull/329): this PR (React-layer cache fix)
- [convex-js#82](https://github.com/get-convex/convex-js/issues/82): upstream Convex issue (setAuth behavior)
- [better-auth/better-auth#9345](https://github.com/better-auth/better-auth/pull/9345): upstream Better Auth complement (preserve caller's session on change-password)

## License

MIT.
