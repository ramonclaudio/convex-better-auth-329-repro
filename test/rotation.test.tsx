/**
 * Real-auth repro for the stale-cached-JWT bug in @convex-dev/better-auth's
 * React provider.
 *
 * No mocked authClient, no synthetic JWTs. Each test wires up:
 *   - Real `better-auth` with `memoryAdapter` and the `@convex-dev/better-auth`
 *     convex plugin on the server side. Sessions are real DB rows; JWTs are
 *     real RS256-signed tokens minted by the plugin.
 *   - Real `createAuthClient` with the `convexClient` plugin and an in-process
 *     `customFetchImpl` that routes requests to `auth.handler`.
 *   - Real `ConvexBetterAuthProvider` rendered under happy-dom.
 *   - One mock: `convex/react`'s `ConvexProviderWithAuth`. It captures the
 *     fetcher and calls it from a child component's `useEffect([fetcher])` to
 *     mirror Convex's `ConvexAuthStateFirstEffect` exactly (which is the
 *     surface where the bug fires).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import * as React from "react";
import { useEffect, type ReactNode } from "react";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/react";
import { parseSetCookieHeader } from "better-auth/cookies";
import { convex } from "@convex-dev/better-auth/plugins";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

process.env.CONVEX_SITE_URL = "http://localhost:3000";

const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-must-be-at-least-32-characters-long-for-this-repro";

const authConfig = {
	providers: [{ applicationID: "convex", domain: BASE_URL }],
};

type Auth = {
	isLoading: boolean;
	isAuthenticated: boolean;
	fetchAccessToken: (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;
};

let setAuthInvocations: Array<{ token: string | null }>;
let capturedFetchers: Auth["fetchAccessToken"][];

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

let ConvexBetterAuthProvider: any;
let auth: ReturnType<typeof betterAuth>;
let authClient: ReturnType<typeof createAuthClient>;
let cookieJar: string;

async function customFetchImpl(input: any, init?: any) {
	const incomingRequest =
		input instanceof Request ? input : new Request(input, init);
	const headers = new Headers(incomingRequest.headers);
	if (!headers.has("origin")) headers.set("origin", BASE_URL);
	if (cookieJar) headers.set("cookie", cookieJar);
	const body =
		incomingRequest.method === "GET" || incomingRequest.method === "HEAD"
			? undefined
			: await incomingRequest.clone().text();
	const request = new Request(incomingRequest.url, {
		method: incomingRequest.method,
		headers,
		body,
	});
	return auth.handler(request).then((response) => {
		const setCookieList: string[] = [];
		const headersAny = response.headers as any;
		if (typeof headersAny.getSetCookie === "function") {
			setCookieList.push(...headersAny.getSetCookie());
		}
		const single = response.headers.get("set-cookie");
		if (single && !setCookieList.includes(single)) setCookieList.push(single);
		const setCookie = setCookieList.join(", ");
		console.log("[fetch]", request.method, request.url, "→", response.status, "cookies:", setCookieList.length);
		if (setCookie) {
			const parsed = parseSetCookieHeader(setCookie);
			const merged = new Map<string, string>();
			if (cookieJar) {
				for (const pair of cookieJar.split(";")) {
					const [name, value] = pair.trim().split("=");
					if (name) merged.set(name, value ?? "");
				}
			}
			for (const [name, attrs] of parsed) {
				merged.set(name, attrs.value);
			}
			cookieJar = Array.from(merged.entries())
				.map(([k, v]) => `${k}=${v}`)
				.join("; ");
		}
		return response;
	});
}

beforeEach(async () => {
	const db = {
		user: [] as unknown[],
		session: [] as unknown[],
		account: [] as unknown[],
		verification: [] as unknown[],
		jwks: [] as unknown[],
	};

	const adapterFactory = memoryAdapter(db);
	const mutationCtxAdapter = (opts: any) => {
		const inner = adapterFactory(opts) as any;
		inner.options = { ...inner.options, isRunMutationCtx: true };
		return inner;
	};

	auth = betterAuth({
		database: mutationCtxAdapter as any,
		emailAndPassword: { enabled: true, autoSignIn: false },
		secret: SECRET,
		baseURL: BASE_URL,
		logger: { level: "debug", disabled: false },
		plugins: [convex({ authConfig })],
	});

	cookieJar = "";
	authClient = createAuthClient({
		baseURL: BASE_URL,
		plugins: [convexClient()],
		fetchOptions: { customFetchImpl },
	});

	setAuthInvocations = [];
	capturedFetchers = [];

	vi.resetModules();
	const mod = await import("@convex-dev/better-auth/react");
	ConvexBetterAuthProvider = mod.ConvexBetterAuthProvider;
});

const TEST_EMAIL = "alice@example.com";
const TEST_PASSWORD = "originalPassword123";

async function signUpAndSignIn() {
	const su = await authClient.signUp.email({
		email: TEST_EMAIL,
		password: TEST_PASSWORD,
		name: "Alice",
	});
	console.log("[diag] signUp:", JSON.stringify(su.data), "err:", JSON.stringify(su.error));
	const si = await authClient.signIn.email({
		email: TEST_EMAIL,
		password: TEST_PASSWORD,
	});
	console.log("[diag] signIn:", JSON.stringify(si.data), "err:", JSON.stringify(si.error));
}

function mount() {
	const mockConvexClient = { setAuth: vi.fn(), clearAuth: vi.fn() };
	return render(
		<ConvexBetterAuthProvider
			client={mockConvexClient as any}
			authClient={authClient}
		>
			<div />
		</ConvexBetterAuthProvider>,
	);
}

describe("convex-better-auth · React provider · session-rotation cache invalidation", () => {
	test("change-password rotation: setAuth-style call must read the new JWT", async () => {
		// Direct API check (bypasses customFetchImpl/cookie plumbing)
		const directSignUp = await auth.api.signUpEmail({
			body: { email: TEST_EMAIL, password: TEST_PASSWORD, name: "Alice" },
			asResponse: true,
		});
		console.log("[direct] signUp status:", directSignUp.status);
		console.log(
			"[direct] signUp set-cookie:",
			(directSignUp.headers as any).getSetCookie?.() ?? directSignUp.headers.get("set-cookie"),
		);
		const directSignIn = await auth.api.signInEmail({
			body: { email: TEST_EMAIL, password: TEST_PASSWORD },
			asResponse: true,
		});
		console.log("[direct] signIn status:", directSignIn.status);
		console.log(
			"[direct] signIn set-cookie:",
			(directSignIn.headers as any).getSetCookie?.() ?? directSignIn.headers.get("set-cookie"),
		);
		mount();

		await waitFor(() => {
			expect(setAuthInvocations.at(-1)?.token).toBeTruthy();
		});
		const tokenBefore = setAuthInvocations.at(-1)?.token;

		await act(async () => {
			await authClient.changePassword({
				currentPassword: TEST_PASSWORD,
				newPassword: "rotatedPassword456",
				revokeOtherSessions: true,
			});
		});

		await waitFor(() => {
			const latest = setAuthInvocations.at(-1)?.token;
			expect(latest).toBeTruthy();
			expect(latest).not.toBe(tokenBefore);
		});
	});
});
