<p align="center">
  <img src="assets/logo.svg" alt="dsh-better-edit" width="200">
</p>

<h1 align="center">dsh-better-edit</h1>

<p align="center">
  <strong>面向 DeepSeek Harness 的哈希锚定编辑工具。<br>
  按内容地址编辑——不靠行号，也不靠字符串替换。更省 token。更多注意力留给真正的工作。绝不会改错行。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#为什么用-hashline">为什么用 Hashline</a> •
  <a href="#基准测试">基准测试</a> •
  <a href="#工具">工具</a> •
  <a href="#致谢">致谢</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.9-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-blueviolet.svg" alt="DeepSeek Harness Plugin">
  <img src="https://img.shields.io/npm/v/dsh-better-edit" alt="npm version">
  <img src="https://img.shields.io/npm/dm/dsh-better-edit" alt="npm downloads">
  <img src="https://img.shields.io/github/stars/Rianico/dsh-better-edit?style=social" alt="GitHub Stars">
</p>

<p align="center">
  <img src="assets/banner.svg" alt="file.ts → read → hashed lines → edit by hash → diff" width="900">
</p>

---

> *"瓶颈在于 harness——而不是模型。"*
> —— Can Bölük，[*The Harness Problem*](https://stencil.so/blog/the-harness-problem)

大多数编辑工具要求模型在改动任何东西之前，先**逐 token** 复述旧代码——而这正是 Agent 最容易出错的地方：多个模型在 replace 式编辑下的补丁格式失败率高达 46–51%。**dsh-better-edit** 走得更远。文件的每一行都分配一个唯一的 3 字符内容哈希，编辑时按哈希定位。旧文本从不回显，锚点在编辑后依然有效，每个解析出的范围都会与模型实际看到的内容逐一核对——错行编辑不可能悄悄落盘。

## 为什么需要它

`str_replace` 会让模型逐字复述它要替换的代码——纯粹的转录成本（输出 token，按约 5-6 倍输入计费），也是 Agent 最容易出错的地方：真实模型补丁失败率高达 46–51%，块越大越糟，每次失败都要重新读取并重试。

Hashline 用两个哈希代替旧文本——**编辑 token 减少 31%**（多行范围达 43%）——并对照模型所见内容校验每个范围：编辑要么落在你想要的行的位置，要么响亮失败并回传新锚点。锚点是内容地址，上方编辑后依然有效，连续编辑无需重读；上下文更精简，模型的注意力也保持在代码上，而不是复述上。

不适用于单行小改动（接近持平）或新建文件（用 `write`）。它的价值在长会话与结构性编辑中体现——任何不允许改错行的场景。

## 快速开始

### 安装

```sh
dsh plugin --profile <name> add dsh-better-edit   # 从 npm
dsh plugin --profile <name> add /path/to/dsh-better-edit   # 从本地源码
```

该 profile 的下一个会话将带着 hashline 工具运行。验证该层是否生效：

```sh
dsh --profile <name> --dump-config   # 会显示 "# == dsh-better-edit" 层
```

| 要求 | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0`（dsh 的要求；存储使用 `node:sqlite`） |
| Profile | 一个 dsh profile（首次使用 `dsh plugin` 时初始化） |
| 后端 | 支持沙箱/远程文件系统（写入经 `ctx.fs`） |

`read` 返回的每一行都带有哈希前缀——哈希*就是*这一行的地址：

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

`edit` 按哈希范围定位，因此编辑总能落在你想要的行的位置：

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "szJ",
  "replacement_text": "  console.log('hi');"
}
```

并产生带全新锚点的 diff，让下一次编辑无需重新读取即可通过校验：

```text
− szJ │   console.log("world");
+ a3m │   console.log('hi');
  kQm │ }
```

## 为什么用 Hashline

**省 token。** 一次编辑调用只携带 `remove_from` / `remove_to`（两个 3 字符哈希）加替换文本——从不回显被替换的文本。`str_replace` 调用则必须逐字复现被替换的文本。在一个真实文件上的 12 次编辑会话中，这可以**减少 31% 的输出 token**（多行范围达 43%）——而且这些是*输出* token，按输入的约 5-6 倍计费。见[基准测试](#基准测试)。

**但这从来不是“最省 token”。** 节省随被替换文本的规模增长——单行微调时几乎持平——而且像 [@oh-my-pi/hashline](#对比) 这样的紧凑补丁语言还能发出更轻的负载（同一会话中 42–53%）。关键在于**正确形态**的编辑调用：不复述旧代码，模型除了两个稳定的内容地址外无需跟踪任何东西。

**正确性。** 每个解析出的编辑范围都会与模型实际看到的行逐行核对。过期、从未提供或歧义的范围会在**写入任何内容之前**被硬性拒绝，并把当前范围以全新锚点的形式回显（reject-and-serve）——重试无需 `read`。

**面向 Agent 的现代编辑范式。** 内容地址锚点与行号无关：编辑文件的一部分，其余行的哈希保持不变，因此连续编辑无需重新读取。模型按行**是什么**来定位，而不是按它之前在第几行。

### 对比

| | hashline `edit` | `str_replace`（Claude Code / Codex） | @oh-my-pi/hashline 补丁 |
| --- | :---: | :---: | :---: |
| 调用中回显被替换文本 | ✅ 不需要——两个哈希 | ❌ 逐字回显 | ✅ 不需要——`+` 行 |
| 按什么定位行 | 内容哈希 | 文本匹配 | 行号 + 文件内容标签 |
| 对照模型所见内容校验 | ✅ 每一行 | ❌ 取第一个匹配 | ~ 仅文件版本 |
| 检测文件已过期 | ✅ 拒绝并回传新锚点 | ❌ 可能匹配到错误位置 | ✅ 标签不匹配 → 拒绝或三方合并 |
| 上方编辑后锚点依然有效 | ✅ 内容寻址 | ✅ 基于内容 | ❌ 重新编号 + 新标签 |
| 连续编辑无需重读 | ✅ diff 提供新锚点 | ~ | ~ 从编辑响应取行号 |
| 文本重复时无歧义 | ✅ 边界锚点需校验 | ❌ 取第一个出现 | ~ 按位置，行未逐行校验 |
| 错行编辑会悄悄落盘 | ❌ 不可能 | ✅ | ~ 可能（标签只校验版本，不校验行） |
| 块操作 / 寄存器 / `MV` / `REM` | ❌ | ❌ | ✅ |
| 一次变更一个文档 | ❌ 每次一个调用 | ❌ 每次一个调用 | ✅ 多 hunk 补丁 |
| 运行时 | ✅ Node（dsh） | — | ⚠️ 仅 Bun |
| 撤销 | ✅ 持久化 | ❌ | ❌ 不在范围内 |

> `~` = 偶尔/不稳定。`@oh-my-pi/hashline` 是一种紧凑的行锚定补丁语言（[npm](https://www.npmjs.com/package/@oh-my-pi/hashline)、[仓库](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)）：`[path#tag]` 头把每个 hunk 绑定到全文件内容哈希，`PUT N.=M:` 按行号定位；每次编辑都会重新编号——下一次的行号与标签取自编辑响应或重新 `read`。

**不同的工作，同一条血脉。** 两者都源于 [harness-problem](https://stencil.so/blog/the-harness-problem) 的洞见：模型绝不该复述旧代码。`@oh-my-pi/hashline` 是**补丁语言库**——负载更轻（每次编辑省 42%，单个批量文档省 53%，见[基准测试](#基准测试)），支持语法块操作（`PUT N*:`）、寄存器、`REM`/`MV`、多 hunk 文档、可插拔文件系统（任何后端），以及标签过期时的会话感知三方合并恢复。本插件则是一对 **dsh 工具**：`read` 把 3 字符内容哈希交给模型，`edit` 取其中两个，并对解析出的每一行对照已提供状态校验——无需重新编号、无需重新取标签、错误锚点永远不可能落到错误的行，`undo_last_edit` 重启后依然有效。代价：每次编辑的 JSON 外壳会多一点负载、没有块操作，并且它活在 dsh（Node）内部，而不是独立补丁器（Bun）。要跨后端的补丁格式选 hashline 库；要在 Agent 里做可校验、内容寻址的编辑，选 hashline 工具。

## 基准测试

在同一份 103 行文件上、用相同的 12 组替换（8 个单行、4 个 3/6/10/15 行多行），以固定的 `js-tiktoken` `cl100k_base` 词表测量。三个被测方发出相同的替换文本：本插件的 `edit`（两个 3 字符锚点）、`str_replace` 工具（逐字回显旧文本）、以及 [`@oh-my-pi/hashline`](https://www.npmjs.com/package/@oh-my-pi/hashline) 的两种模式——每次编辑一个 `[path#tag]` 段（`seq`）和一个多 hunk 批量文档（`batch`）：

| 指标 | hashline | str_replace | oh-my-pi seq / batch |
| ----------- | :---: | :---: | :---: |
| 被替换文本是否上线 | ✅ 从不 | ❌ 每次编辑都发 | ✅ 从不 |
| 输出 token 节省（12 次编辑） | ✅ **31%** | ❌ 0% | ✅ **42% / 53%** |
| 多行范围节省（3–15 行） | ✅ **29–47%** | ❌ 0% | ✅ **40–53%** |
| 按 5 倍输出计价的实际成本 | ✅ **低约 1.4 倍** | ❌ 1× | ✅ **低约 1.7 倍 / 2.1 倍** |
| 范围对照已提供状态校验 | ✅ 100% | ❌ 无 | ~ 仅文件版本 |
| 模型需要跟踪的行号 | ✅ 无——内容锚点 | ✅ 无——文本匹配 | ❌ 每次编辑重新编号 |
| 确定性、可在本地复现 | ✅ `npm run benchmark` | — | — |

### 可复现

上面的数字**是确定性的，你可以本地复现**——`npm run benchmark`：

| 场景 | 行数 | hashline | str_replace | oh-my-pi seq | oh-my-pi batch |
| --- | :---: | :---: | :---: | :---: | :---: |
| 单行 ×8 | 1 | 309 | 324 | 241 | — |
| 多行 ×4 | 3–15 | 393 | 691 | 349 | — |
| **合计 ×12** | | **702** | **1015** | **590** | **480** |

相对 `str_replace` 的节省：hashline **313（31%）** · oh-my-pi 逐次 **425（42%）** · oh-my-pi 批量 **535（53%）**。

脚本天然确定：固定语料、内容寻址且自带自检的编辑脚本（语料被重排会直接抛错，而不是悄悄改变测量对象）、固定版本的 tokenizer，且 oh-my-pi 负载在计数前会对照其发布的语法校验。因为一切都是固定的，`npm run benchmark` 对每个人都是同一个结果——本 README 里的数字就是该次运行的一个快照；重新生成，不要轻信。

> **范围与诚实。** 基准测试衡量的是**请求负载 token**——每次编辑调用时模型发出的内容——读文件流量完全相同故已排除（可抵消），替换文本也完全一致。它**没有**建模转录失败与重试，而真实差距恰恰主要在那边：最初的 [harness-problem](https://stencil.so/blog/the-harness-problem) 文章报告改用锚定编辑后**输出 token 减少 61%**，补丁失败率从 46–51% 降至接近零。它同样**没有**建模行号格式在调用**之间**让模型付出的代价——每次编辑后重新编号、重新获取文件标签——也不包括块操作能力、Bun 与 Node 的运行时差异，以及 `@oh-my-pi/hashline` 是独立补丁器、而本插件是带 `read`/`edit`/`undo` 的 dsh 工具对这一事实。完整方法论、逐编辑表与完整局限清单见 [`benchmark/README.md`](benchmark/README.md)。

## 工具

| 工具 | 作用 |
| ------ | ------ |
| `read` | 以 `HASH│内容` 形式返回文件。参数：`offset`（1 起始）、`limit`。分页输出以 `[Showing lines N-M of T. Use offset=… to continue.]` 结尾。超过 200KB 的行显示为标记并附 `sed` 提示——哈希锚点需要完整行。 |
| `edit` | 按哈希替换行范围。`path` · `remove_from` · `remove_to` · `replacement_text`（`""` 表示删除）。对解析出的范围内**每一行**对照已提供状态校验；`[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]` 拒绝并回传新锚点。 |
| `batch_edit` | 单次原子调用最多 32 项编辑：`{ edits: [{ path?, remove_from, remove_to, replacement_text }, …] }`。全有或全无；失败项的范围会以新锚点的形式回显。 |
| `undo_last_edit` | `{ path }` 撤销该文件上一次 hashline 编辑，仅当文件仍与存储的编辑后内容一致时生效；重启后依然有效。 |

### 错误码

| 代码 | 含义 |
| --- | --- |
| `[E_ACCESS]` | 文件存在但工具不可读/不可写。 |
| `[E_AMBIGUOUS_ANCHOR]` | 一个哈希匹配当前多行；调用 `read` 获取新锚点。 |
| `[E_BAD_OP]` | 范围结束先于范围开始（首尾颠倒时会自动纠正）。 |
| `[E_BAD_REF]` | `remove_from`/`remove_to` 不是裸 3 字符哈希。 |
| `[E_BAD_SHAPE]` | 请求/字段形态错误（未知字段、缺少 path、非字符串文本等）。 |
| `[E_BARE_HASH_PREFIX]` | `HASH│` 前缀被粘贴进 `replacement_text`（自动纠正）。 |
| `[E_BATCH_ABORT]` | 批次内某项失败；整个批次被拒绝，未写入任何内容。 |
| `[E_FILE_TOO_LARGE]` | 文件超过 hashline 行数上限；请改用 `write` 或其他方式。 |
| `[E_INVALID_PATCH]` | diff 预览标记被粘贴进 `replacement_text`（自动纠正）。 |
| `[E_NOOP_LOOP]` | 完全相同的编辑反复不产生任何变化；再次提交会被拒绝。 |
| `[E_NOT_FOUND]` | 文件不存在。 |
| `[E_NOT_OBSERVED]` | 该文件在本会话中尚未被观察（先读后写策略）；请先调用 `read`。 |
| `[E_NOT_TEXT]` | 路径是目录、二进制或非 UTF-8 文件；hashline 只能编辑文本。 |
| `[E_RANGE_STALE]` | 某行自被读取以来在磁盘上发生变化；范围以全新锚点回显。 |
| `[E_RANGE_UNSERVED]` | 范围内包含从未提供给模型的行。 |
| `[E_RANGE_UNVERIFIED]` | 边界锚点无法对照已提供状态验证。 |
| `[E_STALE_ANCHOR]` | 锚点不再能解析；调用 `read` 获取新锚点。 |
| `[E_UNDO_STALE]` | 无法撤销：编辑之后文件被修改（或删除）。 |
| `[E_UNDO_UNAVAILABLE]` | 撤销历史无法持久化；编辑未被应用。 |
| `[E_WOULD_EMPTY]` | 编辑会把非空文件清空；请用 `write` 清空。 |

## 如何替换内置工具

dsh 的工具注册表按作用域解析：agent 看到的是 `agent → preset → global`，且**自身**层总是优先。内置的 `read`/`edit` 位于 agent-preset 层，因此普通的全局注册无法替换它们。本插件：

1. 通过其 `cordis.patch.yml` bundle 补丁作为宿主层 Cordis 插件挂载。
2. 在 `agent/session-start` 时，将 hashline 工具**以及** `tool:read` / `tool:edit` 提示词片段注册到 agent 自身的作用域层——从而为该 agent 遮蔽 preset 的内置工具，并在 agent 销毁时自动解除。
3. 保留内置的 `write`，但通过一个作用域内的 `tools/post-execute` 监听器把 hashline 自动读取附加到 write 结果之后。

## 存储

哈希快照、已提供状态行与撤销历史存放在一个 SQLite 库中，**与被编辑的工作区放在一起**——每个会话 cwd 一个库：

```
<workspace>/.dsh_better_edit/hash-store.sqlite
```

不同工作区中的并行会话各自持有独立的库（会话 cwd 会随每次工具调用传递），因此一个项目的锚点与撤销历史不会泄漏到另一个项目。在工具调用之外（测试、预览）会回退到共享的 DeepSeek Harness 主目录（`$DSH_HOME/plugins/dsh-better-edit/hash-store.sqlite`）。

7 天 TTL 会清理已提供的行；启动时清理缺失文件的快照。损坏的库会被隔离并自动重建。迁移到按工作区布局**不会**迁移共享主目录中的早期撤销历史——把 0.1.2 之前的撤销记录视为已丢失。

## 项目结构

```
dsh-better-edit/
├── src/
│   ├── hashline/        # 哈希 + 已提供状态核心（从 pi-hashline-edit-lsz 逐字节移植）
│   ├── tool-read.ts     # read  — HASH│内容、offset/limit 分页
│   ├── tool-edit.ts     # edit  — 按哈希范围、reject-and-serve
│   ├── tool-batch-edit.ts
│   ├── tool-undo.ts     # undo_last_edit
│   ├── sandbox.ts       # FsSandboxController 镜像（sandbox_permissions/justification）
│   ├── write-hook.ts    # 附加到 write 结果的自动读取
│   ├── served-store.ts  # 按工作区的 SQLite 存储（node:sqlite）
│   └── workspace.ts     # 会话 cwd 的 AsyncLocalStorage 载体
├── benchmark/           # 可复现的 hashline、str_replace 与 oh-my-pi token 基准测试
│   └── corpus/          # 固定的 103 行语料
├── test/                # 615 个测试（移植 + 回归）
├── assets/              # logo 与 banner
├── cordis.patch.yml     # bundle 补丁
└── package.json         # dsh.bundle manifest
```

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run（615 个测试）
npm run build       # tsc → lib/
npm run benchmark   # 可复现的 token 成本基准测试（benchmark/）
```

### 发布流程（先打 tag）

```sh
npm run release -- 0.2.0                 # 升版本 + 迁移 CHANGELOG + 提交 + 打 tag + 推送 → 生成 GitHub release
npm publish --registry https://registry.npmjs.org   # 版本未打 tag 前会被阻止
```

`npm run release` 会更新 `package.json`/lockfile、把 CHANGELOG 的 `[Unreleased]` 段落迁移到版本号下、提交、打 `vX.Y.Z` tag 并推送——tag 推送会基于 changelog 自动创建 GitHub release。`npm publish` 在该 tag 存在之前会拒绝运行（prepublishOnly 门禁），因此每个 npm 版本都一定已经打好 tag 并发布过 release。

测试套件移植自 pi-hashline-edit-lsz，通过本地文件系统桥接直接驱动 dsh 工具构建器。

## 路线图

**当前状态（0.1.7）：** 615 个测试、按工作区存储、参与沙箱策略、served-tail 截断修复、可复现基准测试、中英双语 README、已发布 npm。

<details><summary>下一步</summary>

- 在 dsh 会话中实测 0.1.7（served-tail 修复之后）。
- 把 served-tail 截断修复回馈给 pi-hashline-edit-lsz / 上游（他们的 `upsertServed` 同样从不截断）。
- 对照下一个 dsh 版本重新核对插件接线（当前固定在 `0.1.0-rc.6`；dsh 处于开发者预览阶段，承诺会有破坏性变更）。

</details>

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)（或者直接开 [issue](https://github.com/Rianico/dsh-better-edit/issues)）。当前最有价值的贡献是更多基准场景和针对已提供状态校验的边界测试。

## 许可证

MIT License——详见 [LICENSE](LICENSE)。移植自 pi-hashline-edit-lsz（MIT），其本身带有 RimuruW 与 YuGiMob 的上游版权声明。

## 致谢

哈希锚定编辑源于 Can Bölük 的 [*The Harness Problem*](https://stencil.so/blog/the-harness-problem)——那篇文章证明了瓶颈在于 harness 而非模型，并证明锚定编辑优于搜索替换。本项目站在以下巨人的肩膀上：

- [**pi-hashline-edit**](https://github.com/RimuruW/pi-hashline-edit)（RimuruW）——引入 3 字符哈希与冲突消解的原创 pi-coding-agent 扩展。
- [**pi-hashline-edit-pro**](https://github.com/YuGiMob/pi-hashline-edit-pro)（YuGiMob）——本仓库 hashline 核心所移植自的加固版 fork。
- [**pi-hashline-edit-lsz**](https://github.com/Rianico/pi-hashline-edit-lsz)——本项目所跟随的自维护 fork。hashline 核心逐字节移植；工具层基于 dsh 的插件 API 重写。

延伸阅读：[Hash anchors + Myers diff + single-token anchors（dirac.run）](https://dirac.run/posts/hash-anchors-myers-diff-single-token)（关于编辑调用 O(S+R) → O(R) 节省的设计评论）以及一个独立的 [hashline 与 replace 对比基准测试](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html)。

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Rianico/dsh-better-edit&type=Date)](https://star-history.com/#Rianico/dsh-better-edit&Date)

---

<p align="center">
  <strong>⭐ 如果 hashline 编辑让 Agent 的编辑更可靠，就给它一个 star 吧！</strong>
</p>
