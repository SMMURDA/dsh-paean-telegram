/**
 * dsh-harness-feed: DeepSeek Harness 原生流式输出（取代 openclaw 风格草稿）。
 *
 * 不再模仿 openclaw 的单条流动草稿，而是直接复用 harness 自身的输出管线——
 * 与 web 端（api-proxy → ui-conversation）完全同源的三层机制：
 *
 * 1. 同一事件源：`ctx.on("session/event")`，按 chat 绑定路由。
 * 2. 同一套 assistant 块折叠语义（web ui-conversation conversation-nodes/
 *    assistant.ts）：`assistant/chunk` 的 block-start / text-delta /
 *    reasoning-delta / block-end 折叠为 per-(step, index) blocks——折叠粒度
 *    与 web 一致（一次折叠 = 一条助手消息 = 一个 LLM step），因为
 *    chunk.index 在 agentic 回合的每个 step 都从 0 重来，裸 index 会让后续
 *    step 覆盖前文（HF-1）；text 块即正文、reasoning 块即 Think；多步正文
 *    按 (step, index) 序拼进同一个 ANSWER 气泡。
 * 3. 同一套工具呈现词汇：`ctx.tools.get(name, scope).presentCall /
 *    presentResult` 产出 ToolCallView / ToolResultView（generic / terminal /
 *    diff / search / read / web 卡），presenter 失败软回退 generic——与
 *    api-proxy viewFor 的行为一致。不再维护手写 emoji 表 + JSON 转储。
 *
 * 渲染语义对齐 web 聊天视图：
 * - Think 行 = ReasoningRow：运行中显示最新一行，结束后冻结首行；
 * - 工具行 = 工具卡紧凑版：pending 标题来自 presentCall，完成态后缀来自
 *   presentResult（exit code / 匹配数 / 来源数…）；
 * - 正文 = 助手文本块实时打字机流式（web 的 markdown 气泡），turn/end 以
 *   已提交的 assistant/message 为权威终稿——旧 openclaw 草稿要等回合结束
 *   才投递正文，这里与 web 一致边生成边读。
 *
 * 回合布局：ACTIVITY 卡（Think + 工具行，结束时折叠为收据/空态通知）+
 * ANSWER 消息（流式正文，最终保留在会话里）。openclaw 时代的可靠性机制
 * （占位领养 #12/#23、降级通知 #13/#33、diff 编辑 #15、心跳预算 #48、
 * Abort 停止阀、错误回合收据抑制 #37）全部保留。
 *
 * HF-2 生命周期补充：超过 transport 单条上限的回答，流式期只编辑尾窗
 * （带截断标记），turn/end 撤回气泡并走 host.send 的 splitText 分片路径
 * 完整投递；仍在途的 "…" 占位由 turn/end 延迟结算（原位收编），无主落地
 * 的占位被删除而不是永远留在聊天里；session/event 监听在 teardown 时
 * 退订，热重挂载不会叠加监听导致重复渲染。
 *
 * HF-3 生命周期修正：`outbound.liveFeed=false` 只关渲染、不关生命周期——
 * turn/start / turn/end 的登记与结算无条件执行（此前回合中途关掉开关会
 * 留下僵尸卡片：心跳继续编辑至 MAX_HEARTBEATS 上限、条目要等下一次
 * turn/start 才被回收；开局关、结束前开则凭空推一条 "🤷 Empty response"）。
 * 渲染副作用统一由 turn 级 canRender 快照门控（粘性：中途重开不为该回合
 * 复活过期渲染，核心转发器独占投递）；出错回合不再折叠成成功收据（#37：
 * 失败时 summary 直接抑制，占位走删除路径，让核心的分类失败消息独立呈现）；
 * reasoning 冻结提交时无条件排一帧活动刷新（block-end 会清空 liveThinkRaw，
 * 否则冻结首行要等无关事件才上屏）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ExtensionHost } from "./types.js";
/** Cordis dependency: the main dsh-telegram plugin's provided bridge host.
 * The loader waits for this service and hands it over as `ctx.telegram`. */
export declare const inject: string[];
export declare function unmountHarnessFeed(): void;
export declare function apply(ctx: Context, _config?: unknown): void;
/**
 * Mount the harness-native streaming feed onto a bridge host. Built-in entry
 * used by index.ts; idempotent while active.
 */
export declare function mountHarnessFeed(host: ExtensionHost, ctx: Context): void;
