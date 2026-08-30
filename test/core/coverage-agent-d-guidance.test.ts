import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePresetGuidance, DEFAULT_PRESETS, GUIDANCE_HOME_README } from "../../src/guidance/materialize.js";
import { GUIDANCE_SECTIONS } from "../../src/guidance/resolve.js";
import { isBlankOverride } from "../../src/guidance/parse.js";

async function tmpHome() {
  const p = await mkdtemp(join(tmpdir(),"guidance-test-"));
  return p;
}

describe("coverage-agent-d guidance materialize", () => {
  it("seeds presets idempotently", async () => {
    const home = await tmpHome();
    await ensurePresetGuidance(home);
    for (const preset of DEFAULT_PRESETS) {
      for (const sec of GUIDANCE_SECTIONS) {
        const c = await readFile(join(home,preset,sec.file),"utf-8");
        expect(c).toContain("order:");
      }
    }
    // second call should not overwrite edited file
    const editPath = join(home, DEFAULT_PRESETS[0]!, GUIDANCE_SECTIONS[0]!.file);
    await writeFile(editPath, "custom content");
    await ensurePresetGuidance(home);
    expect(await readFile(editPath,"utf-8")).toBe("custom content");
    await rm(home,{recursive:true,force:true});
  });
  it("heals blank override", async () => {
    const home = await tmpHome();
    await ensurePresetGuidance(home);
    const p = join(home, DEFAULT_PRESETS[0]!, GUIDANCE_SECTIONS[0]!.file);
    await writeFile(p, "   \n  ");
    expect(isBlankOverride("   \n ")).toBe(true);
    await ensurePresetGuidance(home);
    const healed = await readFile(p,"utf-8");
    expect(healed).toContain("order:");
    await rm(home,{recursive:true,force:true});
  });
  it("does not heal malformed fence", async () => {
    const home = await tmpHome();
    await ensurePresetGuidance(home);
    const p = join(home, DEFAULT_PRESETS[0]!, GUIDANCE_SECTIONS[0]!.file);
    await writeFile(p, "---\norder: not-int\n---\nbody");
    await ensurePresetGuidance(home);
    expect(await readFile(p,"utf-8")).toContain("not-int");
    await rm(home,{recursive:true,force:true});
  });
  it("handles custom preset healing and ghost cleanup", async () => {
    const home = await tmpHome();
    await ensurePresetGuidance(home);
    const custom = join(home, "mypreset");
    await mkdir(custom,{recursive:true});
    const secFile = GUIDANCE_SECTIONS[0]!.file;
    await writeFile(join(custom, secFile), "   ");
    await writeFile(join(home, DEFAULT_PRESETS[0]!, "batch_edit.md"), "ghost");
    await writeFile(join(custom, "batch_edit.md"), "ghost2");
    await ensurePresetGuidance(home);
    // blank healed
    expect((await readFile(join(custom,secFile),"utf-8")).includes("order:")).toBe(true);
    // ghosts removed
    const entries = await readdir(join(home, DEFAULT_PRESETS[0]!));
    expect(entries.includes("batch_edit.md")).toBe(false);
    const customEntries = await readdir(custom);
    expect(customEntries.includes("batch_edit.md")).toBe(false);
    // readmes created
    expect(await readFile(join(home,"README.md"),"utf-8")).toContain("dsh-better-edit guidance");
    expect(await readFile(join(home,"README.zh.md"),"utf-8")).toContain("dsh-better-edit");
    // second call readmes not overwritten
    await writeFile(join(home,"README.md"), "custom readme");
    await ensurePresetGuidance(home);
    expect(await readFile(join(home,"README.md"),"utf-8")).toBe("custom readme");
    await rm(home,{recursive:true,force:true});
  });
  it("concurrent write race handled (wx)", async () => {
    const home = await tmpHome();
    // call twice concurrently
    await Promise.all([ensurePresetGuidance(home), ensurePresetGuidance(home)]);
    expect(await stat(join(home, DEFAULT_PRESETS[0]!))).toBeDefined();
    await rm(home,{recursive:true,force:true});
  });
});
