import { AlertCircle, TriangleAlert } from "lucide-react";
import { ModelConfig } from "@/components/ModelSettingsModal";
import { PreferenceSettings } from "@/components/PreferenceSettings";
import { DeviceSelection } from "@/components/DeviceSelection";
import { LanguageSelection } from "@/components/LanguageSelection";
import { TranscriptSettings } from "@/components/TranscriptSettings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductButton, ProductSelect } from "@/components/ui/ProductControls";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useConfig } from "@/contexts/ConfigContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRecordingState } from "@/contexts/RecordingStateContext";

type ModalType = "modelSettings" | "deviceSettings" | "languageSettings" | "modelSelector" | "errorAlert" | "chunkDropWarning";

interface SettingsModalsProps {
  modals: Record<ModalType, boolean>;
  messages: { errorAlert: string; chunkDropWarning: string; modelSelector: string };
  onClose: (name: ModalType) => void;
}

export function SettingsModals({ modals, messages, onClose }: SettingsModalsProps) {
  const {
    modelConfig, setModelConfig, models, modelOptions, error,
    selectedDevices, setSelectedDevices, selectedLanguage, setSelectedLanguage,
    transcriptModelConfig, setTranscriptModelConfig, showConfidenceIndicator,
    toggleConfidenceIndicator,
  } = useConfig();
  const { isRecording } = useRecordingState();
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";

  return (
    <>
      <Dialog open={modals.modelSettings} onOpenChange={(open) => !open && onClose("modelSettings")}>
        <DialogContent className="flex max-h-[88vh] max-w-4xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
            <DialogTitle>{zh ? "偏好设置" : "Preferences"}</DialogTitle>
            <DialogDescription>{zh ? "管理常用偏好与 AI 总结模型。" : "Manage general preferences and the AI summary model."}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-5">
            <PreferenceSettings />
            <section className="border-t border-border/70 pt-6">
              <h3 className="text-sm font-semibold text-foreground">{zh ? "AI 模型配置" : "AI model configuration"}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{zh ? "选择用于生成智能记录的服务和模型。" : "Choose the provider and model used for smart records."}</p>
              <div className="mt-4 grid grid-cols-[minmax(130px,0.4fr)_minmax(180px,1fr)] gap-2">
                <ProductSelect
                  value={modelConfig.provider}
                  onChange={(event) => {
                    const provider = event.target.value as ModelConfig["provider"];
                    setModelConfig({ ...modelConfig, provider, model: modelOptions[provider][0] });
                  }}
                >
                  <option value="builtin-ai">{zh ? "内置 AI" : "Built-in AI"}</option>
                  <option value="claude">Claude</option><option value="groq">Groq</option>
                  <option value="ollama">Ollama</option><option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                </ProductSelect>
                <ProductSelect value={modelConfig.model} onChange={(event) => setModelConfig((previous: ModelConfig) => ({ ...previous, model: event.target.value }))}>
                  {modelOptions[modelConfig.provider].map((model: string) => <option key={model} value={model}>{model}</option>)}
                </ProductSelect>
              </div>
              {modelConfig.provider === "ollama" && (
                <div className="mt-5">
                  <h4 className="text-xs font-semibold text-foreground">{zh ? "可用的 Ollama 模型" : "Available Ollama models"}</h4>
                  {error && <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
                  <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {models.map((model) => (
                      <button type="button" key={model.id}
                        className={`rounded-lg border p-3 text-left transition ${modelConfig.model === model.name ? "border-primary/45 bg-primary/10" : "border-border/70 hover:bg-accent/50"}`}
                        onClick={() => setModelConfig((previous: ModelConfig) => ({ ...previous, model: model.name }))}
                      >
                        <span className="block text-[13px] font-medium text-foreground">{model.name}</span>
                        <span className="mt-1 block text-[11px] text-muted-foreground">{zh ? "大小" : "Size"}: {model.size} · {zh ? "更新" : "Modified"}: {model.modified}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
          <DialogFooter className="mx-6 mb-5">
            <ProductButton variant="primary" onClick={() => onClose("modelSettings")}>{zh ? "完成" : "Done"}</ProductButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.deviceSettings} onOpenChange={(open) => !open && onClose("deviceSettings")}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{zh ? "音频设备" : "Audio devices"}</DialogTitle><DialogDescription>{zh ? "选择会议录音使用的麦克风和系统声音来源。" : "Choose the microphone and system audio sources used for recording."}</DialogDescription></DialogHeader>
          <DeviceSelection selectedDevices={selectedDevices} onDeviceChange={setSelectedDevices} disabled={isRecording} />
          <DialogFooter>
            <ProductButton variant="primary" onClick={() => {
              const micDevice = selectedDevices.micDevice || (zh ? "默认设备" : "Default");
              const systemDevice = selectedDevices.systemDevice || (zh ? "默认设备" : "Default");
              toast.success(zh ? "音频设备已更新" : "Audio devices updated", { description: zh ? `麦克风：${micDevice}；系统声音：${systemDevice}` : `Microphone: ${micDevice}; System audio: ${systemDevice}` });
              onClose("deviceSettings");
            }}>{zh ? "完成" : "Done"}</ProductButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.languageSettings} onOpenChange={(open) => !open && onClose("languageSettings")}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{zh ? "识别语言" : "Recognition language"}</DialogTitle><DialogDescription>{zh ? "设置录音转写时优先识别的语言。" : "Set the language preferred during transcription."}</DialogDescription></DialogHeader>
          <LanguageSelection selectedLanguage={selectedLanguage} onLanguageChange={setSelectedLanguage} disabled={isRecording} provider={transcriptModelConfig.provider} />
          <DialogFooter><ProductButton variant="primary" onClick={() => onClose("languageSettings")}>{zh ? "完成" : "Done"}</ProductButton></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.modelSelector} onOpenChange={(open) => !open && onClose("modelSelector")}>
        <DialogContent className="flex max-h-[88vh] max-w-4xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-5">
            <DialogTitle>{messages.modelSelector ? (zh ? "需要配置语音识别" : "Speech recognition setup required") : (zh ? "转写模型设置" : "Transcription model settings")}</DialogTitle>
            <DialogDescription>{zh ? "选择适合当前会议的识别模型与参数。" : "Choose the recognition model and options for this meeting."}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <TranscriptSettings transcriptModelConfig={transcriptModelConfig} setTranscriptModelConfig={setTranscriptModelConfig} onModelSelect={() => onClose("modelSelector")} />
          </div>
          <DialogFooter className="mx-6 mb-5 items-center sm:justify-between">
            <label className="flex min-w-0 items-center gap-3 text-left">
              <Switch checked={showConfidenceIndicator} onCheckedChange={toggleConfidenceIndicator} />
              <span className="min-w-0"><span className="block text-xs font-medium text-foreground">{zh ? "显示识别置信度" : "Show confidence indicators"}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{zh ? "用状态标记提示转写质量。" : "Show compact quality indicators in transcripts."}</span></span>
            </label>
            <ProductButton onClick={() => onClose("modelSelector")}>{messages.modelSelector ? (zh ? "取消" : "Cancel") : (zh ? "完成" : "Done")}</ProductButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.errorAlert} onOpenChange={(open) => !open && onClose("errorAlert")}>
        <DialogContent className="max-w-md">
          <DialogHeader><span className="mb-1 grid h-9 w-9 place-items-center rounded-lg bg-destructive/10 text-destructive"><AlertCircle className="h-4 w-4" /></span><DialogTitle>{zh ? "录音已停止" : "Recording stopped"}</DialogTitle><DialogDescription>{messages.errorAlert}</DialogDescription></DialogHeader>
          <DialogFooter><ProductButton onClick={() => onClose("errorAlert")}>{zh ? "知道了" : "Dismiss"}</ProductButton></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.chunkDropWarning} onOpenChange={(open) => !open && onClose("chunkDropWarning")}>
        <DialogContent className="max-w-md">
          <DialogHeader><span className="mb-1 grid h-9 w-9 place-items-center rounded-lg bg-amber-100 text-amber-700"><TriangleAlert className="h-4 w-4" /></span><DialogTitle>{zh ? "转写速度暂时跟不上录音" : "Transcription is falling behind"}</DialogTitle><DialogDescription>{messages.chunkDropWarning}</DialogDescription></DialogHeader>
          <DialogFooter><ProductButton onClick={() => onClose("chunkDropWarning")}>{zh ? "知道了" : "Dismiss"}</ProductButton></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
