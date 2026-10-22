/**
 * The directory a tool call operates in. dsh 0.2.1 moved the LIVE directory
 * out of the immutable session header (which keeps only the creation
 * directory) into the `workingDirectory` service's session projection, so an
 * in-session `working_directory` change must retarget every hashline call.
 * These cases pin the precedence: live service first, header only as the
 * fallback for compositions that predate the service.
 * @module dsh-better-edit/exec-cwd.test
 */
import { describe, expect, it } from "vitest";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { execCwd } from "../../src/workspace-context.js";

function execWith(agent: unknown): ToolExecution {
  return {
    signal: new AbortController().signal,
    arguments: {},
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution;
}

function agentWith(session: unknown, workingDirectory?: unknown): unknown {
  return {
    id: "session-1",
    session,
    ctx: {
      get: (name: string) => (name === "workingDirectory" ? workingDirectory : undefined),
    },
  };
}

describe("execCwd", () => {
  it("reads the live directory from the workingDirectory service", () => {
    const session = { id: "session-1", header: { cwd: "/original" } };
    const workingDirectory = { get: (seen: unknown) => (seen === session ? "/moved" : "/wrong") };
    const exec = execWith(agentWith(session, workingDirectory));
    expect(execCwd(exec)).toBe("/moved");
  });

  it("falls back to the session header when the service is absent", () => {
    const session = { id: "session-1", header: { cwd: "/original" } };
    expect(execCwd(execWith(agentWith(session)))).toBe("/original");
  });

  it("falls back to the header for a context without get", () => {
    const session = { id: "session-1", header: { cwd: "/original" } };
    expect(execCwd(execWith({ id: "session-1", session }))).toBe("/original");
  });

  it("uses process.cwd() for a header-less session without the service", () => {
    const exec = execWith(agentWith({ id: "session-1", header: {} }));
    expect(execCwd(exec)).toBe(process.cwd());
  });

  it("uses process.cwd() when the call carries no agent", () => {
    expect(execCwd(execWith(undefined))).toBe(process.cwd());
  });
});
