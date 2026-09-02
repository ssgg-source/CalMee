# 会议与日程关联改造：第一批

日期：2026-09-02。开发基线为 `f1b6e49` 加已有工作区修改；发布分支为 `release/0.1.0-alpha.4`。以下为第一批实现和测试记录。用户授权后已完成本机应用/一致性数据库备份，安装新版并成功进入首页；破坏性测试仅使用临时 fixture。发布限制见 `releases/0.1.0-alpha.4.md`。

## 已实施

- 新增 `meeting_calendar_links`，以 meeting ID 主键和 event ID 唯一约束保证一对一关系。两个旧字段暂作兼容读投影，由关联表触发器同步。
- 关联、解除和显式转移统一经过事务。不存在的会议/日程、被占用日程、过期的当前关联或过期的占用者确认均拒绝；失败不清除旧关联。
- 旧版关联先完整保存到 `meeting_calendar_link_legacy_claims`。仅导入无歧义的一对一关系；矛盾或悬空记录保留待审查，不按更新时间猜测归属。受影响会议的关联选择器显示核对提示。
- `api_update_meeting_schedule` 不再隐式写关联。默认关联不修改标题或时间；选择器提供明确的、一次性“采用日程计划时间”选项。
- 会议详情与录音页共用 `CalendarLinkDialog`；日历待关联会议列表也复用该组件。日程详情的反向关联使用同一后端事务接口，与远端日程内容保存分开，因此只读 macOS 日程也能关联。
- 选择器按时间重叠、开始时间距离及标题字符重合排序。默认查前后七天，关键词可搜索其他已同步日期；最多读取 300 条候选，按时间距离预排序。当前关联保留，其他会议占用明确标注；录音草稿不能抢占已有会议的日程。
- 转移操作同时确认日程当前占用者和目标会议当前关联，避免旧窗口解除/覆盖其他窗口刚做的修改。
- 录音选中的日程与笔记会话、选择 token 绑定。修改标题不再解除选择。正常保存录音、仅保存笔记、删除录音但保留笔记均执行关联；失败保留 meeting/event ID 重试标记，不撤销已保存内容。下一场会话的选择不会被旧回执清除。
- 关联操作通知全部会议元数据和日历；会议详情重新读取实际关联状态。月视图移除关联会议的重复条目，日程上标示已关联；待关联侧栏提供关联操作，移除批量删除入口。
- CalDAV 同步发现源事件删除时，解除旧投影与删除事件放入同一事务；关联表由外键级联清除。

## 主要文件

- `frontend/src-tauri/migrations/20260902100000_add_meeting_calendar_links.sql`
- `frontend/src-tauri/migrations/checksums.json`
- `frontend/src-tauri/src/meeting_workspace.rs`（接口、事务、推荐及 focused tests）
- `frontend/src-tauri/src/calendar_integration.rs`（时间修改与删除事务）
- `frontend/src-tauri/src/lib.rs`（命令注册）
- `frontend/src/components/MeetingWorkspace/CalendarLinkDialog.tsx`
- `frontend/src/components/MeetingWorkspace/MeetingWorkspaceShell.tsx`
- `frontend/src/app/calendar/page.tsx`
- `frontend/src/app/recording/page.tsx`
- `frontend/src/hooks/useRecordingStop.ts`
- `frontend/src/components/RecordingControls.tsx`
- `frontend/src/lib/recording-calendar.ts`
- `frontend/src/lib/refresh-state.ts`
- `frontend/src/i18n/locales/{zh-CN,en}.ts`
- `frontend/scripts/test-refresh-consistency.mjs`

校验清单使用仓库标准 SHA-384；顺带修正已有未提交 `20260902090000_add_custom_model_profiles.sql` 的清单算法值，没有更改该迁移 SQL。

## 验证

- Rust `calendar_link_tests`：9 项通过，涵盖冲突拒绝、显式转移、解除保留时间、事务回滚、旧冲突保留、单向旧关联迁移、源事件删除、目标不存在、旧窗口保护和候选查询。
- Rust `calendar_integration::external_transcript_tests`：12 项通过，包含本机快照删除作用域、不完整快照保护、删除事务回滚。
- 前端 refresh + Dedao tests：29 项通过，包含新增的录音会话隔离、失败关联重试、相同日程新选择不被旧回执清除。
- TypeScript、Next production build、cargo check、迁移校验、release boundary、git diff --check 通过。
- 全部 36 项 SQL 在全新内存 SQLite 顺序迁移通过；`PRAGMA foreign_key_check` 无违规。
- Rust release 编译通过。Tauri 打包的 xattr 清理失败后，仅对生成的工作区 `.app` 修复权限/扩展属性，完成本机 ad-hoc 签名及严格签名验证；不是正式公证发布。
- 未使用真实日历和会议进行破坏性测试；桌面 WebView 的点击流程尚需试用验收。

## 安装与回退

新前端必须与新桌面后端一起使用，不能只刷新旧桌面壳的前端，否则新命令不存在。首次运行新包前应退出旧 App 并备份公共应用数据库（含一致的 WAL 状态）。本次安装前已完成备份并检查完整性；升级由应用的正常启动迁移流程执行，没有直接修改迁移记录。

不支持直接用旧程序打开新迁移后的数据库。若需回退，应使用迁移前备份；不能删除 `_sqlx_migrations` 记录来强行降级。旧字段兼容投影只是过渡读接口，并不代表数据库版本可安全降级。

## 第二批边界

- 周期事件的 `RECURRENCE-ID`、账户/日历作用域身份、TZID 和夏令时未在本批改变。
- 计划时间与实际录音时间尚未新增独立字段；本批仅消除不同入口的隐式覆盖。“采用计划时间”为一次性复制，不代表后续源日程改期自动修改实际录音时间。
- 候选查询有 300 条上限；不是完整历史日程分页器。没有远端在线搜索，也不自动同步或自动绑定。
- 源日程删除后保留会议并解除关联；本批未新增长期日程变更历史/缺失状态。
- 未实现对旧 app 无会话范围 `recording_calendar_event_id` 的隐式恢复；新流程不再读取该旧键。录音中断恢复和跨进程录音会话持久化需第二批补齐。
- 日/周视图可通过日程详情打开会议，但其录音/笔记细分徽标及完整视觉回归仍需后续统一。

## 桌面验收建议（仅一次性测试内容）

1. 从只读本机日程关联测试会议，打开会议确认一致；再从会议页解除。
2. A 关联 E 后，将 E 转移至 B：A 变待关联，A/B 内容均保留。
3. 两个窗口分别操作同一会议，验证旧窗口提示关联已变化，不覆盖新关系。
4. 录音页先选日程，分别验证只保存笔记、保存录音、放弃音频保留笔记。
5. 在源日历删除一次性测试事件后同步：会议保留、关联解除、当前页立即更新。
