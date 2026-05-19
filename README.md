# convex-better-auth #329 repro

[Closed PR #329](https://github.com/get-convex/better-auth/pull/329) on `@convex-dev/better-auth` tried to drop the cached JWT when `useSession()` reported a new session id, so that change-password rotations (or any other session-rotating endpoint) didn't leave the Convex client holding a JWT bound to the dead session. This repro reproduces the bug end-to-end and shows that a `useEffect`-based fix doesn't actually land because of React's effect-ordering. Moving the check into the fetcher's synchronous prelude does.

## Run

You need Bun. Node + npm works if you swap commands.

```bash
bun install
bun run test:bug             # pristine 0.12.2, no patch
bun run test:329             # the original PR #329 attempt (useEffect-based)
bun run test:ref-fix         # in-fetcher rotation detection + ref (the working fix)
bun run test:ref-fix-render  # alternative using during-render reset (works but triggers React warnings)
```

Each script swaps a specific build of `node_modules/@convex-dev/better-auth/dist/react/index.js` into place and runs the same vitest. The variants live in `patches/`.

## Results

| Test | pristine | `useEffect` (PR's original) | `useEffect` + ref | **in-fetcher + ref** |
|---|---|---|---|---|
| rotation A → B: cached fetcher returns new JWT | FAIL | FAIL | FAIL | PASS |
| forceRefreshToken=true always mints fresh | pass | pass | pass | pass |
| logout (sessionId → null) clears cached JWT | FAIL | FAIL | PASS | PASS |
| cold-start sign-in: no spurious cache thrash | pass | pass | pass | pass |
| SSR hydration: initialToken short-circuits without fetch | pass | pass | pass | pass |
| rapid rotation A → B → C: cache drops at each step | FAIL | FAIL | FAIL | PASS |
| rotation while fetch in flight: pending dropped, fresh fetch | FAIL | pass | pass | pass |
| **setAuth-style call on rotation: child effect reads new JWT** | FAIL | FAIL | FAIL | PASS |
| late-resolving stale token() must not overwrite fresh cache | FAIL | FAIL | FAIL | PASS |
| **Total** | **3 / 9** | **4 / 9** | **5 / 9** | **9 / 9** |

The four-column comparison maps to the variants in `patches/`:

- `pristine.js`: the released `0.12.2`.
- `useEffect`: the original `50dea0d` patch alone. Adds a `useEffect` that calls `setCachedToken(null)` on rotation but doesn't touch the closure-captured state.
- `useEffect` + ref: 50dea0d's useEffect plus a `cachedTokenRef`. This is `patches/329-rays-fix.js` plus the cachedTokenRef pattern. Still subject to the effect-ordering hazard (`patches/329-rays-fix.js` here represents this column for the runnable scripts).
- **in-fetcher + ref**: rotation detection inside the fetcher's synchronous prelude, no separate useEffect. Cache is invalidated inline with the cache lookup. This is `patches/ref-fix.js` and is what the upstream PR ships.

## What the tests cover

`test/rotation.test.tsx` mounts `ConvexBetterAuthProvider` in happy-dom. The mocked `convex/react` includes a child component (`MockSetAuthEffect`) that calls `fetcher({forceRefreshToken: false})` from a `useEffect([fetcher])`. This mirrors Convex's `ConvexAuthStateFirstEffect` in `convex/src/react/ConvexAuthState.tsx`, which is what reads the cache on every auth state change. Without that child-effect path, a test using `latestFetcher()(...)` after `act()` would miss the bug entirely.

The rotation event `rotate(toId)` simulates exactly what `$store.notify("$sessionSignal")` does in production. Three real sources land here:

| Upstream cause | Path to `useSession()` |
|---|---|
| `changePassword({ revokeOtherSessions: true })` | server rotates session → Set-Cookie → atomListeners fires `$sessionSignal` (merged in `better-auth/better-auth#9087`) → useSession refetches |
| Cross-domain handoff via `?ott=` | provider's effect at `src/react/index.tsx:65` calls `authClientWithCrossDomain.updateSession()` which calls `$store.notify("$sessionSignal")` directly (`src/plugins/cross-domain/client.ts:110`) |
| Custom plugin endpoint that calls `setSessionCookie` | client atomListeners fires `$sessionSignal` for the matched path |

## Why the useEffect-based attempts don't fix the bug

The patch in `50dea0d` and any "useEffect + ref" variant adds a `useEffect([sessionId])` that calls `setCachedToken(null)` on rotation. The problem is when that effect fires relative to Convex's actual cache read:

1. `useSession()` reports new session id. `useUseAuthFromBetterAuth` runs in the parent (`ConvexBetterAuthProvider`).
2. `useCallback([sessionId])` rebuilds `fetchAccessToken`. The new function reference flows down through `ConvexProviderWithAuth` to its child `ConvexAuthStateFirstEffect`.
3. React commits. Effects fire **child-first**.
4. `ConvexAuthStateFirstEffect`'s `useEffect([fetcher, ...])` re-runs because the fetcher identity changed. It synchronously calls `client.setAuth(fetcher)` → `setConfig` → `fetcher({forceRefreshToken: false})`.
5. The fetcher's synchronous prelude reads `cachedTokenRef.current` / `cachedToken`. The cache still holds the pre-rotation JWT.
6. The fetcher returns the stale JWT.
7. The parent's rotation `useEffect` fires next (parent effects fire AFTER child effects). It clears the cache. Too late.

The cache must be invalidated synchronously, inside the fetcher itself, before the cache lookup.

## What the working fix does

`patches/ref-fix.js` is the shape shipped in PR #329:

1. `cachedToken` is mirrored in a `cachedTokenRef`. The fetcher reads the ref at call time. A `setCachedToken` wrapper writes both (mutating the ref synchronously, scheduling the state update).
2. Rotation detection runs inline at the top of `fetchAccessToken`. When `sessionId !== lastSessionIdRef.current` (both defined), it clears `cachedTokenRef`, `pendingTokenRef`, and the state mirror BEFORE the cache lookup.
3. The token-fetch chain captures its own promise and guards `.then`/`.catch`/`.finally` with `pendingTokenRef.current === tokenPromise`. A late-resolving stale request can't write its dead-session JWT into the cache after a fresher fetch has populated it.

## The ref-fix-render alternative

`patches/ref-fix-render.js` does the rotation reset during render using the React-docs "[storing information from previous renders](https://react.dev/reference/react/useState#storing-information-from-previous-renders)" pattern. It also passes all 9 tests, but React logs a warning:

```
Cannot update a component (`ConvexBetterAuthProvider`) while rendering a different component (`MockProvider`).
```

The during-render setState is technically legal in React when the call is to the same component, but here `setCachedTokenState` lives in `useUseAuthFromBetterAuth`'s outer scope and is called from inside the inner `useAuthFromBetterAuth`, which React resolves as "different component." The in-fetcher variant avoids the warning by running the setter from a callback Convex invokes, not from render.

## License

MIT.
