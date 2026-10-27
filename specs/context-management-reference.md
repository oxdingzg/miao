# 上下文管理优化参考:magic-context 与 opencode-dcp 分析

两个 MIT 许可的第三方插件已克隆到本机,作为 miao 上下文管理优化的机制参考。
本文记录分析结论与对 miao 的落地建议。克隆位置(仓库工作树之外,不进入 miao 仓库):

- `~/workspace/code/github/magic-context` — cortexkit/magic-context(2.4k stars)
- `~/workspace/code/github/opencode-dcp` — arafays/opencode-dcp v2.0.3

## 一、两个插件的定位对比

| | opencode-dcp | magic-context |
|---|---|---|
| 规模 | ~5.3k 行 TS,单插件 | TS core + Rust module (subc) + Tauri dashboard 的 monorepo |
| 管理权 | **模型自管**:模型调用 `prune` 工具决定裁什么 | **系统自管**:historian 后台分格摘要 + 模型可用 `ctx_reduce` 辅助 |
| 挂点 | `ctx.session.hook("context")`,每次出站 dispatch 变换副本 | `experimental.chat.messages.transform`(v1)/ `Context.session` 域(v2),每 LLM 往返一次 |
| 存储 | 会话级 JSON state(`ctx.storage`),出站-only,存储历史永不变 | 共享 SQLite `context.db`(跨宿主、跨项目),fail-closed |
| 记忆 | 无 | Capture/Consolidate/Recall 完整记忆系统(5 类项目记忆、FTS+向量索引、dreamer 后台校验) |
| 压缩粒度 | 区段块(bN,可继承/丢弃链)+ 工具输出占位符 | 分格 compartments,4 层细节 tier,按年龄/重要性/预算 decay 渲染 |
| 缓存策略 | 出站重排 + 重编号,依赖宿主缓存,无字节级保证 | 字节级缓存稳定性设计(m[0]/m[1] 双槽、SOFT+/SOFT/HARD pass 分类、变异门) |

## 二、opencode-dcp 机制细节

核心管线(`lib/transform.ts`):`scan → refs → 压缩块应用 → 工具输出裁剪 → 重扫描 → 边界标签 → 提醒`。
每次 dispatch 在出站副本上执行;数组槽位替换/拼接,不深改存储消息。

1. **`prune` 工具**(`lib/prune-tool.ts`,758 行,最大的文件):
   - 模型提交 `[{ startId, endId, summary }]`,用自己的密摘要替换闭合区段。
   - 边界 ID:mNNNN 每次出站 dispatch **重编号且严格递增**(编号即时间序);bN 是已压缩块。
   - 新摘要可写 `(bN)` 一次来继承旧块全文,省略即永久丢弃;只在占位符内允许出现。
2. **零收益拒绝**(`lib/constants.ts:42-43`):对已压缩块再摘要,必须 ≤50% 原摘要体积且省 ≥128 tokens;
   纯死内容丢弃(无占位符继承)减半即可。理由:同尺寸再摘要浪费一整个模型 turn。
3. **自动工具输出裁剪**(`lib/prune.ts` + `lib/protected.ts`):
   - dedupe/purge 两策略;保护规则 = 工具名 glob + 文件路径 glob(从工具入参的 `filePath/file/path/...` 键提取,深度 ≤2)。
   - **成功的 `question/edit/write/patch/prune` 输出永不自动裁剪;失败的调用可清**(失败不承载决策或用户意图)。
4. **提醒体系**(`lib/prompts.ts` + `lib/nudges.ts`)——踩坑后的成品文案:
   - 占用文案**窗口优先**:先报 "X% of your context window",预算只作从句。教训:预算优先的 "999% of the pruning budget" 让模型在 **12% 真实占用时恐慌裁剪**。
   - 每次提醒声明"本 dispatch 重新测量,作废旧数字",防止模型对过期数字二次行动。
   - **post-prune ack**:成功裁剪后的首次 dispatch 发确认,明确"该提醒已解决/是否还需再裁",并区分"没覆盖新消息(只是再摘要了已压缩块,不得重复)"。
   - 迭代 nudge:距上一条用户消息 N 条消息时轻推一次。
5. **窗口获取**(`index.ts`):catalog 单飞(single-flight)+ 完成后才武装的 60s 重试门;解析失败按"列表失败"处理,不用空目录毒化缓存。
6. **边界保护**:内置 agent(title/compaction/summary)不碰;子代理默认跳过(可配)。
7. **TUI companion**(`./tui` 导出):运行时自动发现并加载,出站统计(压缩块、裁剪 tokens、窗口压力)。

## 三、magic-context 机制细节

### 变换 pass 与缓存稳定性(ARCHITECTURE.md 的 mc:protected 核心区)

每次 LLM 往返一个 pass:`usage+调度 → ≥95% 紧急恢复 → 分格触发(只读内存尾部)→ m[0]/m[1] 物化决策 → 标记/strip/replay → 分格注入 → postprocess 变异门`。

- **pass 三分类**:SOFT+(cache hit,m[0]+m[1] **字节相同重放**,稳态)/ SOFT(仅 m[1] 重渲染,`system+m[0]` 保持缓存)/ HARD(m[0] 折叠,整个前缀重建)。
- **变异门** = BUST 子句(只有本来就 bust 前缀的 pass 才允许变异——变异搭已有 bust 的顺风车,不自己引发)∧ VETO 子句(historian 运行中不变异;硬折叠可越过)。
- **四条承重不变量**:
  1. 硬折叠意味着前缀已死 → 一次性清空所有排队工作,**绝不 defer 硬 bust**;
  2. defer pass 必须字节相同重放(冻结 ID 重放模式;全系统唯一占位符字符串 `[dropped §N§]`,是 tag id 的纯函数——从变异内容重新导出字节曾造成连环缓存灾难);
  3. 延迟工作搭下次 bust 顺风车;唯一有界例外:队列裁剪 ≥2% 可用窗口、或第 3 次连续 held execute 时自行引发 bust;
  4. 所有回收 lane(age sweep、heuristic、去重、ctx_reduce drops)**共享一个 bust 许可**,ride-only;单 lane 私自 bypass 即缺陷(2026-09-07 ALF 分裂 bust 事故)。
- **m[0]/m[1] 双槽头部**:m[0] 冻结基线(项目文档+衰减渲染的历史),m[1] 挥发增量(新记忆 watermark、新分格、supersede 增量)。HARD 折叠触发器围绕"**缓存已死才免费折叠**"组织(模型/系统提示变化、空闲超 TTL、epoch 变化);新分格、新记忆明确**不是**触发器(那是 m[1] 的事)。

### Capture / Consolidate / Recall

- **historian**:压力触发(只读内存尾部,不读宿主库)→ protected-tail 边界(不拆工具调用/结果对)→ 分块摘要(prompt 先验证能装进模型窗口)→ 校验(ordinal 递增不重叠;无 lookahead 的末分格丢弃重读)→ 发布(**不强制 bust**,下个重建 pass 才可见)→ decay 渲染。
- **记忆**:5 类(项目规则/架构/约束/配置值/命名),FTS + 向量索引(纯 SQLite blob 内存比对);会话内 `ctx_memory` 增写走 m[1] watermark,非增改走 `memory_mutation_log` 增量,下次自然折叠并入 m[0];只有 dashboard(外部编辑器)才 bump epoch。
- **dreamer**:进程级定时器 + cron,冲突域单租约(所有改记忆的任务共享一个租约);后台写永不强制 bust。
- **失败处理**:存储打不开 → fail-closed 拒发(绝不让 prompt 失管增长);SQLITE_BUSY → 短重试 → LKG(last-known-good)重放 → 拒发 turn;provider 溢出错误被解析并持久化学习到的窗口。
- **压力带**:~85% force band(应用排队工作+紧急回收);provider 实证 95% 且无折可叠时**拒绝该 turn**而不是超限发送。
- **Rust module**(crates/mc-*):TS 层降级为协调者;模块故障时重放 LKG 槽位保住缓存前缀,无法保住时拒发。

## 四、miao 现状对照

已具备(原生引擎 + TS core):

- 用量锚定自动压缩触发:`crates/miao-engine/src/context_trigger.rs`(Budget window/ratio/headroom,`should_compact`,未计数消息 char/3 粗估,gates ①-⑥ 接线);每模型 capacity(#1185/#1331)。
- turn 边界自动压缩与 checkpoint(#734/#738),checkpoint 注入有渲染期 token 预算(#1333)。
- 出站大工具输出裁剪(gate ④):`runtime.rs:1585` 调 `prune_history`(`context_trigger.rs:543`)——预算感知、保护最近 N 轮、裁中段、`[output elided; recall handle ...]` 占位符 + `recall` 工具按 `tool_use_id` 恢复。
- Context Epoch 基线 + 原生上下文目录亲和(`cache_affinity.rs`,#1283)。
- 一条模型提醒:静默进度提醒(`context.rs:598`)。**没有任何上下文压力提醒。**

差距(按两个插件对照):

1. **模型自管裁剪通道**:dcp 的 `prune` / magic-context 的 `ctx_reduce` 都给模型主动权;miao 的裁剪纯系统尺寸驱动,模型只能被动接受。
2. **区段式渐进压缩**:miao 是整段单摘要 checkpoint;两者都做"可继承/可丢弃的区段链"(dcp 的 bN、magic-context 的 compartments + 4 层 decay),旧前缀压缩后 provider 缓存仍可用。
3. **缓存稳定性不变量**:miao 有 Epoch + 目录亲和,但没有 m[1] 增量槽、"变异只搭已有 bust 顺风车"、字节相同重放这类字节级纪律。
4. **提醒文案**:完全没有。两个插件踩过的坑(预算优先文案 → 恐慌裁剪;过期数字 → 重复行动)是现成的教训。
5. **语义保护名单**:miao 的 `prune_history` 只按轮数保护;没有"成功的问题/编辑输出永不自动裁剪、失败输出可清"的语义规则。
6. **项目记忆系统**:magic-context 的核心差异化能力,miao 没有(knowledge 工具是会话级 reviewable 笔记,非项目记忆)。

## 五、对 miao 的落地建议

P1(低成本高收益,主要从 dcp 借):

1. **上下文压力提醒文案**:压缩触发前给模型一条窗口优先的提醒(占用 + 建议动作),声明每轮重测量、作废旧数字;压缩完成后发 ack。不需要新工具,纯 system-reminder。
2. **语义保护名单**:gate ④ 增加"成功的 question/edit/write 类工具输出永不自动 elide;失败输出可清";可再补文件路径 glob 保护。
3. **窗口/目录获取卫生**:确认触发路径的 catalog 读取有单飞 + 重试门(dcp 的 60s 门模式),避免每 dispatch 重复拉取。

P2(中期,从 magic-context 借核心思想):

4. **区段压缩链**:把 checkpoint 单摘要演进为可引用/可丢弃的区段块;新摘要可继承旧块或永久丢弃死内容;零收益拒绝(≤50% 体积且 ≥128 tokens)防止空转。
5. **模型自管 prune 工具**:出站-only 变换 + 模型工具,落在 miao 引擎已有的 durable tool dispatch 上;存储历史不动,recall 已有恢复基建。
6. **变异搭车纪律**:任何出站变换只在本来就重建前缀的 pass 上落地(miao 的 Epoch 切换点即天然 bust 点);defer pass 字节相同重放。

P3(长期):

7. **项目记忆**:capture(压缩时提取决策/约束/惯例)→ consolidate(后台校验/去重/晋升)→ recall(每轮自动浮现 + 按需检索)。miao 的 knowledge 基建(sourced notes、freshness)和 background jobs/cron 可直接承载。
8. **压力带与拒绝**:85% force band / 95% 实证拒绝,替代或补充现有单阈值触发。

## 六、许可与借鉴边界

- 两者均为 MIT。借鉴**机制与思想**自行实现没有许可义务;若直接复用文案(如 dcp 的 CONTEXT_LIMIT_NUDGE)或代码,需在文件旁保留其版权与许可声明。
- magic-context 的 mc:protected 区注明"仅人工编辑",其文档措辞不应照抄。

## 七、展示层:更有用的信息与更好看的图表(怎么做)

三家现状:

- **dcp**:服务器插件把版本化统计快照(`version: 1`,`sessions` 表 + 最近 10 条压缩事件)**原子写(tmp+rename)进 TUI 监听的 JSON 文件**,TUI 热载进响应式 store;可见物 = prompt footer 紧凑行 + transcript 内压缩结算卡片(字符上下文条 `█/·`,60%/85% 压力分色)。
- **magic-context**:Tauri dashboard 的 CacheDiagnostics 有**每步缓存时间线 SVG 图**:每 step 一根柱(高度=该步 prompt tokens),按"上下文窗口变化"分段,**每段独立 y 轴**,窗口在轴内画虚线、远超轴时用离轴标签;另有 MemoryBrowser/DreamerPanel/SessionViewer。
- **miao**:TUI 侧已有 `contextUsage()`(observed vs budget,rejected/compacted 状态)、sidebar 缓存经济(TTL 分色/趋势箭头/turn 速度)、状态行;app 侧 context tab 有分类 breakdown(带配色)与每模型用量。**数据底子最好**:`session_turn_usage` 已持久化每 turn 的 input/output/cache_read/cache_write/**ttft_ms**/cost,按 (session_id, time_created) 建了索引;引擎还产出 `context.pruned` 事件(`runtime.rs:1601`)。缺的不是数据,是时间维度可视化与结算卡片。

### 做法清单(按优先级)

P1(数据已就绪,纯展示层):

1. **app:会话上下文/缓存时间线**(参考 magic-context CacheTimeline):`session_turn_usage` 按 session 取历史(需补一个只读 API 路由),每 turn 一根柱,高度=input+cache_read+cache_write,按窗口变化分段、每段独立 y 轴,压缩事件画竖标记,cache 读写堆叠配色。落点:`session-context-tab.tsx` 新增 timeline 区块。
2. **TUI:压力分色上下文条**:状态行或 sidebar 加 `█/·` 字符条,60%/85% 阈值借用现有 `TTL_COLOR` 语义(muted/warning/error);无窗口数据时显示 tokens 绝对值,不显示百分比。
3. **压缩/裁剪结算事实事件化**:把 `context.pruned` 从日志升级为持久事件(走现有 `event` 表/EventV2),载荷 = before/after/净省/覆盖消息数/触发原因。app 与 TUI 都可订阅,是下面 P2 卡片的数据源。

P2:

4. **TUI:压缩结算卡片**(dcp CompressionCard 式):最近一次压缩/裁剪的主题、覆盖范围、before→after、净省 tokens,以可折叠块落在 transcript;数据来自第 3 条的事件流。
5. **app:breakdown 随时间的堆叠图**:system/user/assistant/tool 分类随 turn 演变,颜色沿用 `BREAKDOWN_COLOR`,让"什么在吃上下文"可见。

### 显示纪律(两个插件的踩坑清单,直接当评审清单用)

1. 永不裸百分比——必须点名度量("X% of window");"-61%" 读作"61% of what?"(dcp issue #2)。
2. 区段缩减百分比和整窗占用百分比不得并排裸放(dcp issue #1:97% 区段挨着 13% 整窗条被误读)。
3. 空闲显示 "idle",不显示 "−0%"(读作正在裁剪)。
4. 时间线按窗口分段、每段独立 y 轴(magic-context issue #173:混轴把柱全部钉满格、标出 >100% 标签)。
5. 窗口远超轴时离轴标签,不硬缩柱高。
6. 颜色语义固定:绿=净省 ≥0;amber=开销未回本/中等压力;红=≥85% 压力;muted=未知。
7. 数字口径沿用 `contextUsage()` 现有区分:被拒请求不显示旧 turn 的计数,compaction 后不显示过期 budget。

### 右侧面板紧凑版(效果图 ⑤)

侧栏(app side panel,~380px)空间有限,信息按密度分层,全尺寸图只放 context tab 展开态:

1. 一行状态:占用 + 迷你条 + 净省;
2. 迷你时间线:柱宽 5px、高 64px,y 轴只留一个最大值刻度;换窗口处 6px 竖向留白 + 段标签("1M")替代独立坐标系,数字看悬停;压缩标记保留(2px 橙刻度);
3. 压缩记录:单行列表(T · 触发方式 · 净省),点开才展开摘要;
4. breakdown:单行 100% 堆叠条(高 10px)+ 行内图例,替代大图。

效果图:`specs/mockups/context-display.html` / `.png`(面板 ⑤ 按真实 380px 宽渲染)。
