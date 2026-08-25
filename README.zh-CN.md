# CalMee

[English](./README.md) · [简体中文](./README.zh-CN.md)

**一款本地优先、模型开放，覆盖会议纪要完整工作流的桌面应用。**

CalMee 把通常分散在多个工具中的环节连接起来：日程上下文、会议录音、语音转写、
文字稿整理、AI 生成纪要，以及会议知识的长期沉淀。你可以录制现场会议，也可以导入
已有音视频；使用本地 ASR 完成转写；再通过本地或云端 AI 模型生成可编辑的会议纪要，
并把最终结果重新关联到对应的日程。

CalMee 只保留一个全功能开源版本，不再区分 Pro 版，没有功能授权门槛、试用期限或许可证激活流程。

> **当前状态：** 预发布。仓库正在准备首个公开 Alpha 版本。请勿把当前版本作为重要
> 录音的唯一备份。

## CalMee 的不同之处

### 1. 从日程到会议纪要的一体化闭环

CalMee 不只是录音机或转写工具的图形界面，而是把以下流程连接在同一个会议空间中：

1. 从本机日历或标准 CalDAV 账号获取会议日程与上下文；
2. 录制麦克风和系统声音，或导入已有音视频；
3. 生成原始文字稿、按说话人整理的版本和 AI 优化版本；
4. 生成可编辑的会议纪要、智能记录和讲话稿等文档；
5. 将完成的纪要重新绑定到日程，方便后续搜索、回顾和持续整理。

日程、原始录音、文字稿和最终文档不会再散落在彼此无关的工具里，而是围绕同一场会议
保持关联。

### 2. 本地优先，但不绑定单一模型

CalMee 从架构上支持灵活选择模型。重视隐私或离线使用时，可以采用完全本地的工作流；
需要更强云端能力时，也可以使用自己的凭据连接外部模型。

- **ASR 适配：** Whisper、Parakeet、FunASR、SenseVoice、Paraformer、Qwen3-ASR
- **AI 文档：** 本地大语言模型，以及用户自行配置密钥的云端模型
- **流程选择：** 录音、导入、转写和总结不被强制绑定到某一个模型供应方

模型权重、用户凭据、会议录音和本地数据库都不会写入源代码仓库。

### 3. 把中文会议转写作为核心场景

CalMee 的中文能力不只是给英文优先的产品加一层中文界面。针对真实中文会议，CalMee
提供了专门的 FunASR 集成，包括：

- VAD、自动标点、时间戳和可配置热词；
- 轻量的单人模式，以及基于 CAM++ 的多人会议模式；
- 按说话人整理文字稿，以及后续人工校正流程；
- SenseVoice、Paraformer、Qwen3-ASR，以及自定义 FunASR/ModelScope 模型 ID；
- 同时支持现场录音和导入媒体的本地处理路径；
- 简体中文与英文界面。

CalMee 的目标不是只提供一个通用的“语音转文字”按钮，而是让人名、行业术语、多人发言
和长时间中文会议真正便于整理、校正和复用。

### 4. 与日程关联的会议知识库

CalMee 可以读取受支持的本机日历，也可以连接遵循标准的 CalDAV 服务。会议纪要能够
绑定到具体日程；尚未关联的录音和导入内容会保留在“会议纪要收件箱”中，等待整理。
最终形成的不只是文件列表，而是能够按会议发生时间和背景持续检索的个人会议空间。

## 核心能力

- 在支持的平台上录制麦克风和系统声音
- 导入音频和视频，不强制后台自动转写
- 本地模型下载与管理；模型权重不进入代码仓库
- 时间戳、自动标点、VAD、热词、说话人识别与人工校正
- 原始、按说话人整理和 AI 优化的多版本文字稿
- 智能记录、会议纪要、讲话稿和可编辑 Markdown 文档
- 本地 AI，以及由用户自行配置密钥的云端模型
- 会议看板、搜索、标签、日程关联和本地数据管理
- macOS 本机日历和标准 CalDAV 集成
- 支持用户明确授权的外部笔记导入，首个连接器为得到笔记
- 简体中文与英文界面

当前公开 Alpha 的功能边界见
[docs/PROJECT_SCOPE.md](./docs/PROJECT_SCOPE.md)。

## 隐私

使用本地 ASR 和本地语言模型时，会议内容可以完全不上传。只有当用户明确选择云端模型
或外部服务时，相关内容才会发送给对应供应方；CalMee 必须在操作开始前明确展示这一
边界。详见 [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)。

## 开发

当前 macOS 开发环境需要：

- macOS 和 Xcode Command Line Tools
- Rust 1.77 或更高版本
- Node.js 24 LTS 和 pnpm
- Python 3.11，用于 FunASR sidecar

```bash
git clone <your-calmee-repository-url>
cd CalMee
./scripts/setup-funasr.sh
cd frontend
pnpm install
pnpm run tauri:dev
```

模型文件只会在用户选择模型后下载。开发虚拟环境、模型缓存、录音、数据库、凭据和构建
产物都不得提交到仓库。

正式桌面安装包保持轻量，**不携带** Python、PyTorch、FunASR 或模型权重。用户首次选择
本地模型时，CalMee 会先展示运行环境的预计下载量、磁盘占用、网络需求、专属安装目录和
第三方许可入口，确认后自动安装一次哈希锁定的隔离环境。验证过的环境可离线复用；安装失败
或取消不会覆盖旧的可用版本。FunASR 与 Qwen3-ASR 权重统一保存在 CalMee identifier 专属应用数据目录下的
`models/funasr` 中；后端验证真实文件后才会显示“已就绪”，用户可以在设置中逐个删除。
如果检测到旧版本留下的兼容缓存，设置页会先显示来源、目标、模型数量和大小，仅在用户明确
确认后复制白名单模型目录；旧缓存不会被移动、修改或删除，导入后仍须成功加载验证才会显示
“已就绪”。
运行环境使用按目标平台区分的哈希锁文件。首次使用安装器会下载固定版本并校验 SHA-256 的
`uv`，安装精确 CPython 与依赖，在临时目录生成依赖/许可证清单并完成自检后再原子切换。
当前 macOS Intel 会在下载前明确阻断，因为锁定的 PyTorch 版本没有兼容安装包。

发布二进制文件前，请遵循
[docs/OPEN_SOURCE_RELEASE_CHECKLIST.md](./docs/OPEN_SOURCE_RELEASE_CHECKLIST.md)；
首次公开仓库请参考 [docs/FIRST_GITHUB_RELEASE.md](./docs/FIRST_GITHUB_RELEASE.md)。

## 参与贡献

请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)、
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) 和 [SECURITY.md](./SECURITY.md)。

## 许可证与上游署名

CalMee 的部分代码源自 Zackriya Solutions 以 MIT 许可证发布的 Meetily 项目。CalMee 是
独立项目，与 Zackriya Solutions 不存在关联，也未获得其背书。

仓库保留了上游版权声明；CalMee 新增代码同样以 MIT 许可证发布。模型权重和其他依赖项
可能采用不同许可证，详见 [LICENSE.md](./LICENSE.md) 和
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
