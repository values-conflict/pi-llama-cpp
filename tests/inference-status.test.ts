import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceStatusManager } from "../src/inference-status";

const SERVER = "http://llama.test:8080";
const CHAT_URL = `${SERVER}/v1/chat/completions`;
const SLOTS_URL = `${SERVER}/slots`;

let manager: InferenceStatusManager;
let realFetch: typeof fetch;
let ui: { setWorkingMessage: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
let networkFetch: ReturnType<typeof vi.fn>;

function sseBody(frames: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frames));
			controller.close();
		},
	});
}

function abortError(): Error {
	return new DOMException("This operation was aborted", "AbortError");
}

/** A network fetch that hangs until its signal aborts (like a server blocking on a model load). */
function hangingFetch(): ReturnType<typeof vi.fn> {
	return vi.fn(
		(_url: unknown, init?: { signal?: AbortSignal }) =>
			new Promise<never>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(abortError());
					return;
				}
				signal?.addEventListener("abort", () => reject(abortError()), { once: true });
			}),
	);
}

beforeEach(() => {
	realFetch = globalThis.fetch;
	manager = new InferenceStatusManager();
	ui = { setWorkingMessage: vi.fn(), setStatus: vi.fn() };
	networkFetch = vi.fn();
});

afterEach(() => {
	manager.uninstall();
	globalThis.fetch = realFetch;
});

/** Install the interceptor with `networkFetch` as the underlying transport. */
function install(): void {
	globalThis.fetch = networkFetch as unknown as typeof fetch;
	manager.install(SERVER);
}

function startRequest(): void {
	manager.onBeforeProviderRequest({ ui, hasUI: true }, "test-model");
}

describe("fetch interceptor", () => {
	it("does not surface an aborted /slots queue poll as a connection error", async () => {
		networkFetch = hangingFetch();
		install();
		startRequest();

		// checkQueue polls /slots and aborts after 500ms; the server (with autoload)
		// blocks that request for the entire model load, so the abort always fires
		// when a prompt is sent to an unloaded model.
		void manager.checkQueue("test-model");
		await new Promise((resolve) => setTimeout(resolve, 550));

		expect(networkFetch).toHaveBeenCalledWith(expect.stringContaining(`${SLOTS_URL}?model=`), expect.anything());
		const calls = ui.setWorkingMessage.mock.calls.map((c) => String(c[0] ?? ""));
		expect(calls).not.toContain(expect.stringContaining("Connection error"));

		// The 2s queue fallback must still show the waiting message, not an error.
		await new Promise((resolve) => setTimeout(resolve, 1600));
		expect(ui.setWorkingMessage).toHaveBeenCalledWith("⏳ Waiting...");
	});

	it("does not surface a client-side abort of the inference request as a connection error", async () => {
		networkFetch = vi.fn(() => Promise.reject(abortError()));
		install();
		startRequest();

		await expect(globalThis.fetch(CHAT_URL, { method: "POST", body: "{}" })).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(ui.setWorkingMessage).not.toHaveBeenCalledWith(expect.stringContaining("Connection error"));
	});

	it("surfaces a genuine network failure of the inference request as a connection error", async () => {
		networkFetch = vi.fn(() => Promise.reject(new Error("fetch failed")));
		install();
		startRequest();

		await expect(globalThis.fetch(CHAT_URL, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");

		expect(ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("Connection error: fetch failed"));
	});

	it("clears a stale error once a new inference response arrives", async () => {
		networkFetch = vi.fn(() => Promise.reject(new Error("fetch failed")));
		install();
		startRequest();

		await expect(globalThis.fetch(CHAT_URL, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
		expect(ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("Connection error"));

		// A retried request succeeds with an SSE stream — the error must clear.
		const body = sseBody(
			'data: {"prompt_progress":{"total":10,"processed":10,"time_ms":5,"cache":0}}\n\ndata: [DONE]\n\n',
		);
		networkFetch.mockImplementation(() => Promise.resolve(new Response(body, { status: 200 })));

		const response = await (globalThis.fetch(CHAT_URL, { method: "POST", body: "{}" }) as Promise<Response>);
		expect(ui.setWorkingMessage).toHaveBeenLastCalledWith(expect.not.stringContaining("Connection error"));

		await response.text(); // drain the stream to completion
	});
});
