import { describe, expect, it } from "vitest";
import { assertEditRequest } from "../../src/contract.js";
import { CodedError, codeOf } from "../../src/utils.js";
import {
	resEdit,
	verifyServedRange,
	AnchorMismatchError,
	ServedRejectionError,
	lineHashesPure,
} from "../../src/hashline/index.js";
import { finalizeResult, type EditDetails } from "../../src/edit-response.js";

function codeOfThrow(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return codeOf(error);
	}
	throw new Error("expected throw");
}

describe("structured error codes (#55 S1)", () => {
	it("contract rejects carry bare E_BAD_PAYLOAD", () => {
		try {
			assertEditRequest({ path: 123, edits: [] });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CodedError);
			expect((error as CodedError).code).toBe("E_BAD_PAYLOAD");
			expect(codeOf(error)).toBe("E_BAD_PAYLOAD");
		}
	});

	it("anchor-syntax throws carry bare E_BAD_ANCHOR", () => {
		expect(codeOfThrow(() => resEdit({ remove_from: "MQX│x", remove_to: "MQX", replacement_text: "y" } as any))).toBe(
			"E_BAD_ANCHOR",
		);
	});

	it("tombstoned anchor with changed canon carries E_STALE_RANGE", () => {
		const hashes = lineHashesPure("a\nb\nc");
		try {
			verifyServedRange({
				served: [...hashes],
				servedCanons: ["zzz", "b", "c"],
				tombstone: new Set([hashes[0]!]),
				startHash: hashes[0]!,
				endHash: hashes[1]!,
				startLine: 1,
				endLine: 2,
				fileHashes: hashes,
				fileLines: ["a", "b", "c"],
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ServedRejectionError);
			expect((error as ServedRejectionError).code).toBe("E_STALE_RANGE");
			expect(codeOf(error)).toBe("E_STALE_RANGE");
		}
	});

	it("interior hole carries E_UNSERVED_RANGE with kind", () => {
		const hashes = lineHashesPure("a\nb\nc");
		try {
			verifyServedRange({
				served: [hashes[0]!, null, hashes[2]!],
				startHash: hashes[0]!,
				endHash: hashes[2]!,
				startLine: 1,
				endLine: 3,
				fileHashes: hashes,
				fileLines: ["a", "b", "c"],
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ServedRejectionError);
			expect((error as ServedRejectionError).code).toBe("E_UNSERVED_RANGE");
			expect((error as ServedRejectionError).unservedKind).toBe("interior");
		}
	});

	it("ambiguous served anchor carries E_UNSERVED_RANGE with boundary kind", () => {
		const hashes = lineHashesPure("a\nb\nc");
		try {
			verifyServedRange({
				served: [hashes[0]!, hashes[0]!, hashes[2]!],
				startHash: hashes[0]!,
				endHash: hashes[1]!,
				startLine: 1,
				endLine: 2,
				fileHashes: hashes,
				fileLines: ["a", "b", "c"],
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ServedRejectionError);
			expect((error as ServedRejectionError).code).toBe("E_UNSERVED_RANGE");
			expect((error as ServedRejectionError).unservedKind).toBe("boundary");
		}
	});

	it("anchor mismatch carries E_STALE_ANCHOR", () => {
		const error = new AnchorMismatchError("m", []);
		expect(error.code).toBe("E_STALE_ANCHOR");
		expect(codeOf(error)).toBe("E_STALE_ANCHOR");
	});

	it("codeOf falls back to message convention, else undefined", () => {
		expect(codeOf(new Error("[MODEL] [E_EMPTY_RANGE] x"))).toBe("E_EMPTY_RANGE");
		expect(codeOf(new Error("plain failure"))).toBeUndefined();
		expect(codeOf("nope")).toBeUndefined();
	});

	it("EditDetails accepts structured errCode/unservedKind", () => {
		const details: EditDetails = { diff: "", errCode: "E_BAD_PAYLOAD", unservedKind: "boundary" };
		expect(details.errCode).toBe("E_BAD_PAYLOAD");
	});
});

describe("batch drift note retired (#55 S2)", () => {
	it("passes warnings through with no special-casing", () => {
		const text = finalizeResult({ diff: "d", warnings: ["Batch drift note: x", "other"] });
		expect(text).toContain("Batch drift note: x");
		expect(text).toContain("other");
	});
});
