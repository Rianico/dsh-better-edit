/**
 * The sandbox-escalation API for the hashline mutating tools, mirroring
 * `@deepseek-ai/dsh-tool-fs`'s `FsSandboxController` (same vocabulary, same
 * fail-closed approval sequence, shared `@deepseek-ai/dsh-sandbox` pieces) so
 * `edit`/`batch_edit`/`undo_last_edit` escalate exactly like the built-in
 * `write`/`edit` — and, critically, stamp the per-call policy with the SESSION
 * workspace root. Without the policy the sandbox backend falls back to the
 * deployment default root, so an edit inside the session workspace is denied
 * under `workspace-write` even though the built-in `write` succeeds there.
 * @module dsh-better-edit/sandbox
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { FsError } from "@deepseek-ai/dsh-fs";
import type {
	SandboxExecutionPolicy,
	SandboxMode,
} from "@deepseek-ai/dsh-sandbox";
import {
	ESCALATION_TARGETS,
	approveEscalation,
	escalationHintMarker,
	sandboxDenialMarker,
	validateEscalationArgs,
} from "@deepseek-ai/dsh-sandbox";

/** The two escalation arguments a mutating tool may carry (advertised only under a confining backend). */
export interface FsEscalationArgs {
	sandbox_permissions?: string;
	justification?: string;
}

/** The schema fields for the escalation arguments, spread into a tool's `parameters` when a confining backend is mounted. */
export interface EscalationSchemaFields {
	sandbox_permissions: { type: "string"; enum: string[]; description: string };
	justification: { type: "string"; description: string };
}

/** The per-session policy resolver shape from `@deepseek-ai/dsh-sandbox-policy`. */
interface SandboxPolicyLike {
	resolve(request?: { session?: unknown }): SandboxExecutionPolicy;
}

/**
 * The filesystem escalation API: advertisement gating, per-call policy
 * resolution, the one-approved wider retry, and denial-marker mapping. A pure
 * product of `ctx` at plugin apply time.
 */
export class FsSandboxController {
	/** The escalation targets this composition advertises (`[]` when no confining backend is mounted). */
	readonly escalationModes: readonly SandboxMode[];
	/** Shared per-session policy resolver, required by a confining backend. */
	private readonly policy: SandboxPolicyLike | undefined;

	constructor(private readonly ctx: Context) {
		const defaultMode = ctx.fs.sandboxMode;
		this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS;
		this.policy =
			defaultMode === undefined
				? undefined
				: (ctx.get("sandboxPolicy") as SandboxPolicyLike);
		if (defaultMode !== undefined && this.policy === undefined) {
			throw new Error(
				"dsh-better-edit: the mounted filesystem confines but ctx.sandboxPolicy is missing",
			);
		}
	}

	/**
	 * The escalation schema fields for a mutating tool's `parameters`. Call it
	 * only under a confining backend (guard on {@link escalationModes}); the
	 * enum pins the closed target vocabulary, the strict-wider check happens
	 * per call at execution.
	 */
	schemaFields(): EscalationSchemaFields {
		return {
			sandbox_permissions: {
				type: "string",
				enum: [...this.escalationModes],
				description:
					"The wider sandbox mode this file operation needs. Only valid as a one-shot retry " +
					"of an operation the sandbox just denied; requires justification and user approval.",
			},
			justification: {
				type: "string",
				description:
					"Required with sandbox_permissions: one sentence for the user explaining " +
					"why this exact file operation needs the wider access.",
			},
		};
	}

	/**
	 * The policy to stamp onto this mutation: an approved escalation grant (a
	 * strictly wider retry resolved through `ctx.approval` before anything
	 * executes), else the session's standing mode. The calling session's cwd is
	 * always carried as the workspace root, so `workspace-write` allows writes
	 * inside the session workspace.
	 * @param toolName - the mutating tool's name, for the approval audit trail.
	 * @param args - the call's escalation arguments.
	 * @param exec - the tool-execution context (agent, callId, signal).
	 * @returns the policy to pass to the mutation, or undefined for an
	 *   unsandboxed backend.
	 */
	async resolvePolicy(
		toolName: string,
		args: FsEscalationArgs,
		exec: ToolExecution,
	): Promise<SandboxExecutionPolicy | undefined> {
		validateEscalationArgs(args.sandbox_permissions, args.justification);
		const standingPolicy = this.policy?.resolve({
			...(exec.agent ? { session: exec.agent.session } : {}),
		});
		if (
			args.sandbox_permissions === undefined ||
			args.justification === undefined
		) {
			return standingPolicy;
		}
		if (this.escalationModes.length === 0) {
			throw new Error(
				"sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)",
			);
		}
		const policy = standingPolicy as SandboxExecutionPolicy;
		const approvedMode = await approveEscalation(
			{
				requestedMode: args.sandbox_permissions,
				justification: args.justification,
				effectiveMode: policy.mode,
				subject: "operation",
			},
			{
				approver: this.ctx.get("approval"),
				agent: exec.agent,
				callId: exec.callId,
				toolName,
				signal: exec.signal,
			},
		);
		return { ...policy, mode: approvedMode };
	}

	/**
	 * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` becomes
	 * the shared `[sandbox: …]` denial marker plus the same-turn escalation
	 * hint, keeping the structured code. Any other error passes through.
	 */
	mapError(
		error: unknown,
		policy: SandboxExecutionPolicy | undefined,
	): unknown {
		if (!(error instanceof FsError) || error.code !== "FS_SANDBOX_DENIED")
			return error;
		const mode = (policy as SandboxExecutionPolicy).mode;
		return new FsError(
			`${sandboxDenialMarker(mode)}\n${escalationHintMarker("operation")}`,
			"FS_SANDBOX_DENIED",
			{ cause: error },
		);
	}
}
