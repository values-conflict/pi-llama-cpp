import { describe, expect, it } from "vitest";
import { formatBytes, llamaInferenceUrl, normalizeLlamaServerUrl } from "../src/client";

describe("formatBytes", () => {
	it("formats bytes", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("formats kilobytes", () => {
		expect(formatBytes(1024)).toBe("1.00 KiB");
		expect(formatBytes(2048)).toBe("2.00 KiB");
		expect(formatBytes(10240)).toBe("10.0 KiB");
		expect(formatBytes(15360)).toBe("15.0 KiB");
	});

	it("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.00 MiB");
		expect(formatBytes(15728640)).toBe("15.0 MiB");
	});

	it("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.00 GiB");
	});

	it("formats terabytes", () => {
		expect(formatBytes(1099511627776)).toBe("1.00 TiB");
	});

	it("uses one decimal for values >= 10", () => {
		expect(formatBytes(102400)).toBe("100.0 KiB");
	});

	it("uses two decimals for values < 10", () => {
		expect(formatBytes(1024)).toBe("1.00 KiB");
	});
});

describe("normalizeLlamaServerUrl", () => {
	it("normalizes basic http URLs", () => {
		expect(normalizeLlamaServerUrl("http://localhost:8080")).toBe("http://localhost:8080");
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
	});

	it("normalizes basic https URLs", () => {
		expect(normalizeLlamaServerUrl("https://example.com")).toBe("https://example.com");
	});

	it("strips trailing slashes", () => {
		expect(normalizeLlamaServerUrl("http://localhost:8080/")).toBe("http://localhost:8080");
		expect(normalizeLlamaServerUrl("http://localhost:8080///")).toBe("http://localhost:8080");
	});

	it("strips /v1 suffix", () => {
		expect(normalizeLlamaServerUrl("http://localhost:8080/v1")).toBe("http://localhost:8080");
		expect(normalizeLlamaServerUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080");
	});

	it("strips search params and hash", () => {
		expect(normalizeLlamaServerUrl("http://localhost:8080?foo=bar")).toBe("http://localhost:8080");
		expect(normalizeLlamaServerUrl("http://localhost:8080#section")).toBe("http://localhost:8080");
	});

	it("trims whitespace", () => {
		expect(normalizeLlamaServerUrl("  http://localhost:8080  ")).toBe("http://localhost:8080");
	});

	it("rejects non-http protocols", () => {
		expect(() => normalizeLlamaServerUrl("ftp://localhost:8080")).toThrow("Server URL must use http or https");
		expect(() => normalizeLlamaServerUrl("ws://localhost:8080")).toThrow("Server URL must use http or https");
	});
});

describe("llamaInferenceUrl", () => {
	it("appends /v1 to the normalized server URL", () => {
		expect(llamaInferenceUrl("http://localhost:8080")).toBe("http://localhost:8080/v1");
		expect(llamaInferenceUrl("http://localhost:8080/")).toBe("http://localhost:8080/v1");
		expect(llamaInferenceUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
	});
});
