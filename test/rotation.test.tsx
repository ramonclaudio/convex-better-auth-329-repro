/**
 * Repro for the stale-cached-JWT bug in @convex-dev/better-auth's React provider.
 *
 * The provider memoizes `fetchAccessToken` with `useCallback(..., [sessionId])` and
 * captures `cachedToken` lexically. When `sessionId` rotates between two non-null
 * values, the captured closure keeps returning the OLD JWT until forceRefreshToken
 * is true. Convex calls fetcher({forceRefreshToken: false}) first on every setAuth,
 * so every query in that window carries the dead session id.
 *
 * The bug fires for every cause of session-id rotation, not just one. The provider
 * doesn't care WHY useSession() reports a new id; it cares that the cache short-
 * circuit reads the wrong value. These tests therefore use a single rotation helper
 * `rotate(toId)` that flips the mocked useSession state and exercises the same
 * code path that production rotation sources hit:
 *
 *   - better-auth `changePassword({ revokeOtherSessions: true })` (issue #6881).
 *     Server-side: better-auth currently deletes the caller's session and mints a
 *     new one, sending a new Set-Cookie. The client's atomListeners fires
 *     $sessionSignal (better-auth/better-auth#9087, merged). useSession() refetches
 *     /get-session and reports the new id. → rotate("B")
 *
 *   - Cross-domain handoff. The provider's effect at src/react/index.tsx:65 reads
 *     `?ott=...`, calls `authClient.crossDomain.oneTimeToken.verify`, then
 *     `authClient.getSession` with a Bearer header, then
 *     `authClientWithCrossDomain.updateSession()`. updateSession just calls
 *     `$store.notify("$sessionSignal")` (src/plugins/cross-domain/client.ts:110),
 *     which causes useSession() to emit the new session id. → rotate("B")
 *
 *   - Custom plugin endpoints. Any user-defined Better Auth plugin endpoint that
 *     calls `setSessionCookie` rotates the session id. The client's atomListeners
 *     fires $sessionSignal for the matched path. → rotate("B")
 *
 * All three upstream causes land in useSession()'s store and emit a new session id.
 * The provider's cached-JWT short-circuit then reads the stale captured value.
 *
 * NOTE on test isolation: the provider has a module-level `initialTokenUsed` flag
 * (src/react/index.tsx:42) that latches true after the first mount. To let every
 * test exercise the initialToken hydration path independently, the suite calls
 * vi.resetModules() in beforeEach and dynamically re-imports the provider. This
 * also gives each test a fresh capturedFetchers array.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as React from "react";
import { useState, useEffect, type ReactNode } from "react";

type Auth = {
	isLoading: boolean;
	isAuthenticated: boolean;
	fetchAccessToken: (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;
};

let capturedFetchers: Auth["fetchAccessToken"][] = [];

// Production-realistic capture of what setAuth observes. Convex's
// ConvexAuthStateFirstEffect runs `client.setAuth(fetchAccessToken)` inside a
// useEffect keyed on [fetchAccessToken], and setAuth synchronously invokes the
// fetcher with forceRefreshToken: false to read the cached token. Because that
// effect lives in a CHILD component of ConvexProviderWithAuth, it fires BEFORE
// any useEffects declared inside useAuth() in the parent — including any
// rotation-cleanup effect. The mock mirrors that contract so a rotation-cleanup
// useEffect that depends on parent-effect ordering is correctly exposed as
// broken. See convex/src/react/ConvexAuthState.tsx.
let setAuthInvocations: Array<{ token: string | null }> = [];

vi.mock("convex/react", () => {
	function MockSetAuthEffect({
		fetcher,
	}: { fetcher: Auth["fetchAccessToken"] }) {
		useEffect(() => {
			let cancelled = false;
			fetcher({ forceRefreshToken: false }).then((token) => {
				if (cancelled) return;
				setAuthInvocations.push({ token });
			});
			return () => {
				cancelled = true;
			};
		}, [fetcher]);
		return null;
	}

	function MockProvider({
		children,
		useAuth,
	}: { children: ReactNode; useAuth: () => Auth }) {
		const auth = useAuth();
		capturedFetchers.push(auth.fetchAccessToken);
		return React.createElement(
			React.Fragment,
			null,
			React.createElement(MockSetAuthEffect, {
				fetcher: auth.fetchAccessToken,
			}),
			children,
		);
	}
	return {
		ConvexProviderWithAuth: MockProvider,
		Authenticated: ({ children }: { children: ReactNode }) =>
			React.createElement(React.Fragment, null, children),
		useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
		useQuery: () => null,
	};
});

type SessionShape = {
	data: { session: { id: string } } | null;
	isPending: boolean;
};

let ConvexBetterAuthProvider: any;

beforeEach(async () => {
	capturedFetchers = [];
	setAuthInvocations = [];
	vi.resetModules();
	const mod = await import("@convex-dev/better-auth/react");
	ConvexBetterAuthProvider = mod.ConvexBetterAuthProvider;
});

/**
 * Test rig mirroring the shape of better-auth's React client surface:
 *   - useSession() returns { data, isPending } and re-renders on rotate().
 *   - authClient.convex.token() returns a JWT bound to whatever session id is
 *     current at the time the fetch resolves, mirroring the real server's
 *     stateless "give me the current session's JWT" semantics.
 *   - rotate(toId) is what `$store.notify("$sessionSignal")` triggers in production
 *     via change-password, cross-domain updateSession(), or any other rotation path.
 */
function makeRig(initial: string | null, opts?: { holdToken?: boolean }) {
	const listeners = new Set<(s: SessionShape) => void>();
	let current: SessionShape = {
		data: initial === null ? null : { session: { id: initial } },
		isPending: false,
	};

	type Held = {
		atSessionId: string | undefined;
		resolve: (value: { data: { token: string | null } }) => void;
	};
	const held: Held[] = [];

	const useSession = () => {
		const [state, setState] = useState(current);
		listeners.add(setState);
		return state;
	};

	const tokenCalls: { atSessionId: string | undefined }[] = [];

	const token = vi.fn((_options?: unknown) => {
		const atSessionId = current.data?.session.id;
		tokenCalls.push({ atSessionId });
		const payload = {
			data: { token: atSessionId ? `JWT-for-${atSessionId}` : null },
		};
		if (opts?.holdToken) {
			return new Promise<typeof payload>((resolve) => {
				held.push({ atSessionId, resolve: () => resolve(payload) });
			});
		}
		return Promise.resolve(payload);
	});

	const authClient = {
		useSession,
		convex: { token },
		updateSession: () => {
			listeners.forEach((listener) => listener(current));
		},
	} as any;

	const convexClient = {
		setAuth: vi.fn(),
		clearAuth: vi.fn(),
	};

	function rotate(toId: string | null) {
		current = {
			data: toId === null ? null : { session: { id: toId } },
			isPending: false,
		};
		listeners.forEach((listener) => listener(current));
	}

	function releaseHeldToken() {
		const items = held.splice(0);
		for (const item of items) item.resolve();
	}

	function releaseLatest() {
		const item = held.pop();
		item?.resolve();
	}

	function releaseOldest() {
		const item = held.shift();
		item?.resolve();
	}

	return {
		authClient,
		convexClient,
		rotate,
		releaseHeldToken,
		releaseLatest,
		releaseOldest,
		tokenCalls,
	};
}

function mount(rig: ReturnType<typeof makeRig>, initialToken?: string | null) {
	return render(
		<ConvexBetterAuthProvider
			client={rig.convexClient as any}
			authClient={rig.authClient}
			initialToken={initialToken ?? undefined}
		>
			<div />
		</ConvexBetterAuthProvider>,
	);
}

const latestFetcher = () => capturedFetchers.at(-1)!;

describe("convex-better-auth · React provider · session-rotation cache invalidation", () => {
	/**
	 * The bug. Maps to: any rotation source.
	 *
	 * Setup mirrors the live state at the moment rotation fires:
	 *   - sessionId = A (the caller's current session)
	 *   - cachedToken state = JWT-for-A (populated by SSR hydration or by the most
	 *     recent fetch cycle that Convex's setAuth ran on this auth state)
	 *
	 * Rotation flips sessionId to B. useCallback rebuilds fetchAccessToken with
	 * cachedToken=JWT-for-A captured. Convex's setAuth(newFetcher) immediately
	 * calls fetcher({forceRefreshToken: false}). The captured cachedToken short-
	 * circuit returns JWT-for-A — bound to the now-deleted session.
	 */
	test("rotation A → B: fetcher({forceRefreshToken:false}) must return the new JWT, not the old one", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		expect(await latestFetcher()({ forceRefreshToken: false })).toBe(
			"JWT-for-session-A",
		);

		await act(async () => rig.rotate("session-B"));

		const tokenAfter = await latestFetcher()({ forceRefreshToken: false });
		expect(
			tokenAfter,
			"cached fetcher returned the JWT bound to the deleted session id",
		).toBe("JWT-for-session-B");
	});

	/**
	 * Sanity check. forceRefreshToken=true bypasses the cache short-circuit entirely
	 * and always mints fresh via authClient.convex.token(). If this regresses, the
	 * fix went too far.
	 */
	test("forceRefreshToken=true always mints fresh, even on the buggy code path", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		await act(async () => rig.rotate("session-B"));

		expect(await latestFetcher()({ forceRefreshToken: true })).toBe(
			"JWT-for-session-B",
		);
	});

	/**
	 * Maps to: logout / sign-out. session goes from { session: {...} } → null.
	 *
	 * The existing logout-cleanup effect at src/react/index.tsx:124 already handles
	 * this case (clears cachedToken when !session && !isSessionPending). The new
	 * rotation effect must NOT also fire here, because the guard
	 * `sessionId !== undefined && lastSessionIdRef.current !== undefined` filters it.
	 *
	 * After logout, fetcher should not short-circuit to the pre-logout JWT.
	 */
	test("logout (sessionId A → undefined): cache cleared, no short-circuit to JWT-for-A", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		await act(async () => rig.rotate(null));

		const tokenAfter = await latestFetcher()({ forceRefreshToken: false });
		expect(tokenAfter).not.toBe("JWT-for-session-A");
	});

	/**
	 * Maps to: cold-start sign-in. sessionId goes from undefined → A.
	 *
	 * The rotation guard's `lastSessionIdRef.current !== undefined` check prevents
	 * the effect from firing on first sign-in. If we cleared on first sign-in,
	 * SSR-hydrated initialToken would get blown away. The fetcher must produce a
	 * working token after a first sign-in without spurious cache thrash.
	 */
	test("cold-start sign-in (undefined → A): fetcher works, no spurious cache thrash", async () => {
		const rig = makeRig(null);
		mount(rig);

		await act(async () => rig.rotate("session-A"));

		expect(await latestFetcher()({ forceRefreshToken: false })).toBe(
			"JWT-for-session-A",
		);
	});

	/**
	 * SSR hydration. The provider exports `initialToken` for server-rendered apps
	 * that pre-fetch the JWT during SSR. On first client render with that token,
	 * fetcher({forceRefreshToken: false}) must short-circuit to the initialToken
	 * without a network call. Verifies the fix doesn't break this path.
	 */
	test("SSR hydration: initialToken short-circuits the first fetcher call without hitting token()", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		expect(await latestFetcher()({ forceRefreshToken: false })).toBe(
			"JWT-for-session-A",
		);
		expect(rig.tokenCalls.length).toBe(0);
	});

	/**
	 * Stress: A → B → C in quick succession (rapid auth state changes, e.g. OAuth
	 * redirect followed by an immediate `updateSession()` to refresh stored data).
	 * The cache must drop at each rotation, not just the first.
	 */
	test("rapid rotation A → B → C: each step drops the cache, no stale at any step", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		await act(async () => rig.rotate("session-B"));
		expect(await latestFetcher()({ forceRefreshToken: false })).toBe(
			"JWT-for-session-B",
		);

		await act(async () => rig.rotate("session-C"));
		expect(await latestFetcher()({ forceRefreshToken: false })).toBe(
			"JWT-for-session-C",
		);
	});

	/**
	 * Race: a token() fetch is in flight when rotation fires.
	 *
	 * Without clearing pendingTokenRef, the next fetcher call returns the in-flight
	 * promise from session A, which (depending on when it reached the server) could
	 * resolve to a JWT bound to either the old or new id. The fix clears
	 * pendingTokenRef so the next call starts a new fetch keyed to the new session.
	 */
	test("rotation while a token() fetch is mid-flight: pending fetch dropped, new fetch keyed to B", async () => {
		const rig = makeRig("session-A", { holdToken: true });
		mount(rig);

		const inFlight = latestFetcher()({ forceRefreshToken: false });
		await new Promise((resolve) => setTimeout(resolve, 0));

		await act(async () => rig.rotate("session-B"));

		const nextCall = latestFetcher()({ forceRefreshToken: false });
		rig.releaseHeldToken();

		await inFlight;
		const fromNextCall = await nextCall;

		expect(fromNextCall).toBe("JWT-for-session-B");
	});

	/**
	 * Production-shape race. Convex's ConvexAuthStateFirstEffect calls setAuth(fetcher)
	 * from a useEffect in a CHILD component. React fires child effects first, so the
	 * child's setAuth → fetcher(false) runs BEFORE any rotation-cleanup useEffect
	 * declared inside the parent's useAuth(). If cleanup lives in a useEffect, the
	 * cache is still stale when the child reads it. The fix must run cleanup as part
	 * of the fetcher's synchronous prelude, not in an effect.
	 */
	test("setAuth-style call on rotation: child effect reads the new JWT, not the stale captured one", async () => {
		const rig = makeRig("session-A");
		mount(rig, "JWT-for-session-A");

		// First setAuth call lands before any rotation. Captures JWT-for-A.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(setAuthInvocations.at(-1)?.token).toBe("JWT-for-session-A");

		await act(async () => rig.rotate("session-B"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The child effect's fetcher reference changes when sessionId rotates, so
		// it re-fires. The token it reads on the post-rotation render must be the
		// new session's JWT, not the cached pre-rotation one.
		expect(
			setAuthInvocations.at(-1)?.token,
			"setAuth-style child effect read the stale JWT bound to the deleted session",
		).toBe("JWT-for-session-B");
	});

	/**
	 * The race CodeRabbit flagged on the reopened PR: a token() request started
	 * before rotation can still resolve AFTER rotation and overwrite the cache.
	 *
	 *   1. fetcher starts at A. Request goes out with cookie=A. Server returns JWT-for-A.
	 *   2. session rotates to B. The rotation effect clears pendingTokenRef and
	 *      cachedTokenRef.
	 *   3. fetcher starts at B. Request returns JWT-for-B. `.then` writes
	 *      cachedTokenRef = JWT-for-B.
	 *   4. The original A request's `.then` resolves last and writes
	 *      cachedTokenRef = JWT-for-A. The cache is now poisoned with a token
	 *      bound to the deleted session, even though every other piece of state
	 *      points at B.
	 *
	 * The fix: each token() request captures its own promise and the `.then` /
	 * `.catch` guards `pendingTokenRef.current === capturedPromise` before
	 * writing. After rotation or a newer fetch replaces the ref, the stale
	 * `.then` bails out.
	 */
	test("late-resolving stale token() must not overwrite the fresh cached JWT", async () => {
		const rig = makeRig("session-A", { holdToken: true });
		mount(rig);

		const inFlight = latestFetcher()({ forceRefreshToken: false });
		await new Promise((resolve) => setTimeout(resolve, 0));

		await act(async () => rig.rotate("session-B"));

		const nextCall = latestFetcher()({ forceRefreshToken: false });
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Release the fresh post-rotation request first, then the stale one
		// second. The stale `.then` resolves last; without a guard, it overwrites
		// the cache with the JWT bound to the dead session.
		rig.releaseLatest(); // fresh B request (latest in queue)
		await new Promise((resolve) => setTimeout(resolve, 0));
		rig.releaseOldest(); // stale A request (oldest in queue)
		await new Promise((resolve) => setTimeout(resolve, 0));

		await inFlight;
		await nextCall;

		// The final cached value should reflect the fresh session, not the
		// late-resolving stale one.
		const final = await latestFetcher()({ forceRefreshToken: false });
		expect(final).toBe("JWT-for-session-B");
	});
});
