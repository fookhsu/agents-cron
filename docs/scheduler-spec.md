# agent-cron 后台任务 Runner 规格

> 状态：已决策，待实现。决策依据见 [Wayfinder map #1](https://github.com/fookhsu/agent-cron/issues/1) 及其子 tickets。

## 目标

在 Pi 中创建和管理定时任务；Pi 退出后，由统一 Task Runner 经 Agent 适配层为每次 Task Run 创建独立 Task Session；系统 Cron 触发 Runner；执行记录不进入用户当前 Pi session。以 KISS 为硬约束：Agent 只作为 SDK 或 CLI 调用，不复制一套 Agent runtime。

## 领域模型

- **Schedule Task**：定时任务定义（时间规则 + prompt + 可选 agent）。
- **Task Run**：任务的一次执行。
- **Task Session**：某次 Task Run 独立创建的 Agent session。
- **Agent Adapter**：把一次 Task Run 驱动到某个具体 Agent runtime 的适配器（Pi、Codex 等）；Agent 专属逻辑只存在于适配器内。
- **Agent Registry**：按 id 解析适配器的注册表；适配器惰性加载，未使用的 Agent SDK 不会被 import。
- **Task Runner**：发现到期任务并交给适配器启动 Task Session 的进程；不感知任何 Agent SDK。
- **User Pi Session**：用户当前交互式 Pi 会话（仅用于管理任务）。

## 架构

```
用户 Pi Session（管理面）
    │  /schedule、schedule_task 工具
    ▼
.pi/scheduler/  store（tasks.json + runs/ + sessions/）
    ▲
    │  系统 Cron
    ▼
agent-cron run-due（执行面，单次幂等）
    └── Task Runner（Agent 无关）
            └── Agent Registry 按 task.agent 解析
                    └── Agent Adapter（内置 Pi；可扩展）
                            └── 对每个到期任务：创建全新 Task Session
```

## CLI 契约

单一二进制 `agent-cron`（`package.json.bin`）：

- `agent-cron run-due [--project <path>] [--agent <id>]` — Cron 唯一入口，执行到期任务。
- `agent-cron run <taskId> [--project <path>] [--agent <id>]` — 立即执行单任务。
- `agent-cron list [--project <path>] [--json]` — 列出任务与最近运行。
- `agent-cron add|enable|disable|remove ...` — 可选 shell 管理；`add --agent <id>` 指定适配器。
- `agent-cron prune --keep <n>` — 清理运行记录。

退出码：`0` 成功（含无到期任务、锁被其他存活实例持有而跳过）；`1` 至少一个任务失败；`2` 配置/存储错误。

项目发现：默认 `cwd`，`--project` 覆盖；不递归扫描。

## 存储布局

```
<project>/.pi/scheduler/              # .gitignore
├── tasks.json                        # 版本化 durable 任务定义（0600）
├── run.lock                          # 项目级运行锁（0600）
├── runs/<runId>.json                 # 每次运行的元数据（0600）
└── sessions/<taskId>/<runId>.jsonl   # 独立 Task Session（0600，SDK 生成后强制 chmod）
```

所有调度文件（tasks.json、run.lock、runs/*.json、sessions/**/*.jsonl）均为 0600；Task Session 文件由 SDK 写入后由 Runner 强制 chmod 0600。

- Task（定义）与 Run（执行记录）分离；运行状态不内联进 `tasks.json`。
- ID：`task_<8hex>`；`run_<YYYYMMDDHHmmss>_<8hex>`。

### 任务定义（tasks.json）

```json
{
  "version": 1,
  "tasks": [{
    "id": "task_a1b2c3d4",
    "name": "daily-audit",
    "prompt": "检查 CI 并分析失败",
    "schedule": { "kind": "once" | "interval" | "cron", "...": "..." },
    "enabled": true,
    "model": "可选覆盖",
    "thinking": "可选覆盖",
    "cwd": "可选覆盖",
    "tools": ["可选 allowlist"],
    "createdAt": "...",
    "updatedAt": "..."
  }]
}
```

### 运行记录（runs/<runId>.json）

```json
{
  "runId": "run_...",
  "taskId": "task_...",
  "trigger": "scheduled" | "manual",
  "startedAt": "...",
  "finishedAt": "...",
  "status": "running" | "success" | "error" | "skipped" | "missed",
  "exitCode": 0,
  "sessionFile": "sessions/task_x/run_y.jsonl",
  "summary": "可选：从最终回复生成",
  "error": "可选"
}
```

## 锁与幂等

- `run-due` 先 `open(run.lock, 'wx')` 原子抢锁；锁内 pid 存活 → 退出 0；pid 已死（stale）→ 删除重试。
- 持锁后逐个到期任务：先写 `runs/<runId>.json`（`running`）再执行，执行完写终态。
- `running` 超过 `runTimeoutMinutes`（默认 30）视为崩溃，可被后续 `run-due` 重新认领（原记录标 `error`）。
- 同项目同时最多一个 `run-due`；任务间串行；不同项目天然并行。

## 到期语义

- 周期任务：到期执行一次（错过多周期折叠为一次 catch-up），随后从当前时间推进 `nextRunAt`；失败不自动重试，等下一周期。
- 一次性任务：成功后 `enabled: false`；逾期超过 `missedGraceMinutes`（默认 5）标 `missed`，需 `run <id>` 手动补跑。

## Task Session

- 每次 run 全新隔离 session（同一任务连续执行得到互不相干的 session；失败不向后续传递上下文）。
- session 文件在 `sessions/<taskId>/<runId>.jsonl`，由 SDK SessionManager 创建（具体 API 以当前 `@earendil-works/pi-coding-agent` 版本为准，实现时锁定）。
- 配置继承：cwd/model/thinking/tools 默认继承项目与用户配置，任务可覆盖；AGENTS.md/skills/extensions 常规加载；调度扩展自身在任务 session 中不参与调度。
- 凭证复用 Pi auth 存储与环境变量，不写进任务文件。

## 管理面（Pi 扩展）

- Commands：`/schedule list|add|enable|disable|run|remove|runs <id>|open <runId>`；`/loop`（创建 durable 周期任务）、`/remind`（一次性）。
- 工具：`schedule_task`（add/list/enable/disable/delete/run/runs）。
- 扩展不拥有后台计时器；只读写 store；`/schedule open <runId>` 输出 session 路径并提示 `pi --session <path>`，绝不合并到当前 session。

## 通知与保留

- 默认不向当前 Pi session 注入任何运行结果；可选在 footer 显示「上次运行状态」。
- 每任务默认保留最近 20 个 run；`prune --keep <n>` 清理。

## Out of scope

- 自动代管 crontab；任务执行任意 shell command；把 Task Session 注入用户 session；分布式/Web/MCP 调度；daemon 常驻（后续可选，仅作 `run-due` 循环包装）。
