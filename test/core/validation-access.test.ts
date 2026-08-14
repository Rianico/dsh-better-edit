import { describe, expect, it, vi } from "vitest";

const accessMock = vi.fn(async () => undefined);

vi.mock("fs/promises", () => ({
  access: accessMock,
}));

function errWithCode(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("valAccess — error mapping", () => {
  it("maps ELOOP to an [E_ACCESS] symlink-loop error", async () => {
    const { valAccess } = await import("../../src/validation");
    accessMock.mockRejectedValueOnce(errWithCode("ELOOP", "too many links"));
    await expect(valAccess("/loop/path", "loop.txt")).rejects.toThrow(
      "[E_ACCESS] Too many symbolic links while resolving: loop.txt",
    );
  });

  it("maps ENOENT to [E_NOT_FOUND]", async () => {
    const { valAccess } = await import("../../src/validation");
    accessMock.mockRejectedValueOnce(errWithCode("ENOENT", "missing"));
    await expect(valAccess("/missing/path", "gone.txt")).rejects.toThrow(
      "[E_NOT_FOUND] File not found: gone.txt",
    );
  });

  it("maps EACCES to a readability error", async () => {
    const { valAccess } = await import("../../src/validation");
    accessMock.mockRejectedValueOnce(errWithCode("EACCES", "denied"));
    await expect(valAccess("/secret/path", "secret.txt")).rejects.toThrow(
      "[E_ACCESS] File is not readable: secret.txt",
    );
  });

  it("maps unknown codes to the generic access error", async () => {
    const { valAccess } = await import("../../src/validation");
    accessMock.mockRejectedValueOnce(errWithCode("EBUSY", "busy"));
    await expect(valAccess("/busy/path", "busy.txt")).rejects.toThrow(
      "[E_ACCESS] Cannot access file: busy.txt",
    );
  });

  it("resolves when access succeeds", async () => {
    const { valAccess } = await import("../../src/validation");
    await expect(valAccess("/ok/path", "ok.txt")).resolves.toBeUndefined();
  });
});
