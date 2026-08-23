# Application data path audit

CalMee Community uses its Tauri identifier (`io.github.ssgg-source.calmee`) as the
boundary for persistent application data. Normal startup must not read or write
the former shared `CalMee` application-support directory.

| Data | Active location or behavior | Classification | Decision |
| --- | --- | --- | --- |
| SQLite database and settings | Tauri `app_data_dir` | Persistent user data | Identifier-isolated |
| FunASR configuration | `app_data_dir/config/funasr.json` | Persistent user configuration | Identifier-isolated; no implicit legacy fallback |
| Hotwords | Community SQLite database | Persistent user data | Empty remains empty; legacy-tagged rows require explicit keep/delete disposition |
| Notification settings | `app_data_dir/config/notifications.json` | Persistent user configuration | Identifier-isolated |
| Custom summary templates | `app_data_dir/templates` | Persistent user configuration | Identifier-isolated |
| Whisper models | `app_data_dir/models` | Downloaded model assets | Identifier-isolated in startup and parallel-processing paths |
| Parakeet models | `app_data_dir/models` | Downloaded model assets | Identifier-isolated in active command paths |
| Summary models | `app_data_dir/models/summary` | Downloaded model assets | Identifier-isolated in active command paths |
| FunASR / Qwen3-ASR models | `app_data_dir/models/funasr/modelscope` and `app_data_dir/models/funasr/huggingface` | Downloaded model assets | Identifier-isolated; readiness is derived from backend-verified files, not browser storage |
| Earlier FunASR / Qwen3-ASR caches | `~/.cache/modelscope` and `~/.cache/huggingface/hub` | Legacy downloaded model assets | Never used by normal loading; read-only allowlist preview and explicit copy only; source is not modified or deleted |
| FunASR readiness records | `app_data_dir/models/funasr/state` | Replaceable local model metadata | Written only after a successful model load; deletion is restricted to recorded paths below the managed roots |
| FunASR Python runtime | Identifier-scoped `runtimes/funasr`; repository `.venv-funasr` only in development | Replaceable tool asset | Release packages do not bundle it; first-use install is hash-locked and system Python fallback is prohibited |
| FunASR bridge audio | `app_data_dir/models/funasr/audio-cache` | Ephemeral processing cache | Identifier-isolated; successful inputs are removed after transcription |
| FFmpeg and helper binaries | Tool/resource paths | Replaceable tool assets | Retained; not user configuration |
| Recording/export folders | User-selected Documents/Movies paths | User-owned output | Retained by design |
| Old CalMee database import | Explicit import source opened read-only | User-authorized migration | Retained; never used by normal startup |

The model engine modules still contain defensive release-build fallback
constructors for callers that do not supply a model directory. Active desktop
commands supply the identifier-specific directory; the parallel Whisper path is
also required to use that directory. These inactive fallbacks are not used for
normal persistence and should not be used by new call sites.

The legacy shared FunASR file is not opened by normal save/load or hotword-list
operations. The legacy-hotword disposition operates only on rows already present
in the Community database and never modifies the shared source file.

ModelScope and Hugging Face user-wide caches are not used by normal CalMee
downloads. Existing files in those caches are neither moved nor deleted
implicitly. A model becomes ready only after CalMee loads it successfully from
its identifier-specific managed directory.
