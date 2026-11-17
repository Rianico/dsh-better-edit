/**
 * EditMode — the one member of the request contract the write pipeline names.
 *
 * WHY a module of its own (ADR-0037): `EditMode` is the only edge from
 * anchor-pipeline back into contract.ts, and contract.ts reaches the read side
 * through `ReadWindow`. Left there, the type re-closed the import ring; as a leaf
 * it closes nothing — both ends import this file and never each other.
 *
 * @module dsh-better-edit/edit-mode
 */

export type EditMode = "general" | "literal";
