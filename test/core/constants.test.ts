import { describe, expect, it } from "vitest";
import {
	AUTO_READ_MAX,
	SNIFF_BYTES,
	SERVED_TTL_MS,
} from "../../src/constants.js";

describe("constants", () => {
	it("AUTO_READ_MAX is a positive number", () => {
		expect(AUTO_READ_MAX).toBeGreaterThan(0);
		expect(typeof AUTO_READ_MAX).toBe("number");
	});


	it("SNIFF_BYTES is a positive number", () => {
		expect(SNIFF_BYTES).toBeGreaterThan(0);
		expect(typeof SNIFF_BYTES).toBe("number");
	});

	it("SERVED_TTL_MS is exactly 7 days", () => {
		expect(SERVED_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
