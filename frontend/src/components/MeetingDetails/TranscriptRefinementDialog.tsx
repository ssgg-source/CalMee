"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpenText,
  Cpu,
  Languages,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfig } from "@/contexts/ConfigContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ModelConfig } from "@/services/configService";

type LocalModel = {
  name: string;
  display_name: string;
  status: { type: string };
};
type CloudModel = { id: string };
type RefinementPreferences = {
  provider?: ModelConfig["provider"];
  model?: string;
  language?: string;
  profile?: "proofread" | "faithful" | "readable";
  useGlossary?: boolean;
  customModel?: boolean;
};
const PREFERENCES_KEY = "calmee.transcript-refinement.preferences.v1";
const PROVIDERS: Array<{ value: ModelConfig["provider"]; label: string }> = [
  { value: "builtin-ai", label: "Local AI" },
  { value: "ollama", label: "Ollama" },
  { value: "minimax", label: "MiniMax" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "kimi", label: "Kimi" },
  { value: "qwen", label: "Qwen" },
  { value: "doubao", label: "Doubao" },
  { value: "zhipu", label: "Zhipu AI" },
  { value: "openai", label: "OpenAI" },
  { value: "claude", label: "Claude" },
  { value: "gemini", label: "Gemini" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom-openai", label: "Custom OpenAI" },
];

export function TranscriptRefinementDialog({
  open,
  onOpenChange,
  meetingId,
  transcriptCount,
  beforeStart,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  meetingId: string;
  transcriptCount: number;
  beforeStart?: () => Promise<void>;
  onStarted: () => void;
}) {
  const { modelConfig, modelOptions } = useConfig();
  const { locale, lt } = useLanguage();
  const zh = locale === "zh-CN";
  const [language, setLanguage] = useState("auto");
  const [profile, setProfile] = useState<"proofread" | "faithful" | "readable">(
    "faithful",
  );
  const [useGlossary, setUseGlossary] = useState(true);
  const modelListId = useId();
  const [provider, setProvider] = useState<ModelConfig["provider"]>(
    modelConfig.provider,
  );
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [starting, setStarting] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<
    Set<ModelConfig["provider"]>
  >(new Set(["builtin-ai"]));

  useEffect(() => {
    if (!open) return;
    setPreferencesReady(false);
    let saved: RefinementPreferences = {};
    try {
      saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}");
    } catch {
      saved = {};
    }
    const preferredProvider = saved.provider || modelConfig.provider;
    const preferredModel =
      saved.model ||
      (preferredProvider === modelConfig.provider
        ? modelConfig.provider === "custom-openai"
          ? modelConfig.customOpenAIModel || modelConfig.model
          : modelConfig.model
        : "") ||
      modelOptions[preferredProvider]?.[0] ||
      "";
    setLanguage(saved.language || "auto");
    setProfile(saved.profile || "faithful");
    setUseGlossary(saved.useGlossary ?? true);
    setProvider(preferredProvider);
    setConfiguredProviders(
      new Set(["builtin-ai", modelConfig.provider, preferredProvider]),
    );
    setCustomModel(saved.customModel ?? false);
    // Show the saved/configured cloud model immediately. Remote discovery can
    // enrich the menu in the background without leaving MiniMax blank first.
    setModel(preferredModel);
    setPreferencesReady(true);
    setLoadingModels(preferredProvider === "builtin-ai");
    void Promise.all(
      PROVIDERS.map(async (item) => {
        if (item.value === "builtin-ai") return [item.value, true] as const;
        if (item.value === "ollama") {
          const list = await invoke<any[]>("get_ollama_models", {
            endpoint: modelConfig.ollamaEndpoint || null,
          }).catch(() => []);
          return [item.value, list.length > 0] as const;
        }
        if (item.value === "custom-openai") {
          const value = await invoke<any>("api_get_custom_openai_config").catch(
            () => null,
          );
          return [
            item.value,
            Boolean(value?.endpoint && value?.model),
          ] as const;
        }
        const key = await invoke<string>("api_get_api_key", {
          provider: item.value,
        }).catch(() => "");
        return [item.value, Boolean(key.trim())] as const;
      }),
    ).then((results) =>
      setConfiguredProviders(
        new Set(
          results.filter(([, ready]) => ready).map(([provider]) => provider),
        ),
      ),
    );
    invoke<LocalModel[]>("builtin_ai_list_models")
      .then((items) => {
        const ready = items.filter((item) => item.status.type === "available");
        setModels(ready);
        if (preferredProvider === "builtin-ai")
          setModel(
            ready.some((item) => item.name === preferredModel)
              ? preferredModel
              : ready[0]?.name || "",
          );
      })
      .catch((error) => {
        setModels([]);
        if (preferredProvider === "builtin-ai") setModel("");
        toast.error(lt("Failed to load local AI models"), {
          description: String(error),
        });
      })
      .finally(() => {
        setLoadingModels(false);
      });
  }, [
    open,
    modelConfig.provider,
    modelConfig.model,
    modelConfig.customOpenAIModel,
    modelOptions,
    lt,
  ]);

  useEffect(() => {
    if (!open || !preferencesReady || !model) return;
    const preferences: RefinementPreferences = {
      provider,
      model,
      language,
      profile,
      useGlossary,
      customModel,
    };
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  }, [
    open,
    preferencesReady,
    provider,
    model,
    language,
    profile,
    useGlossary,
    customModel,
  ]);

  useEffect(() => {
    if (
      !open ||
      provider === "builtin-ai" ||
      provider === "ollama" ||
      provider === "custom-openai"
    ) {
      setRemoteModels([]);
      return;
    }
    let live = true;
    const load = async () => {
      try {
        const apiKey = await invoke<string>("api_get_api_key", { provider });
        if (!apiKey.trim()) return;
        let result: CloudModel[] = [];
        if (
          [
            "minimax",
            "deepseek",
            "kimi",
            "gemini",
            "qwen",
            "doubao",
            "zhipu",
          ].includes(provider)
        )
          result = await invoke<CloudModel[]>("get_china_cloud_models", {
            provider,
            apiKey,
          });
        else if (provider === "openai")
          result = await invoke<CloudModel[]>("get_openai_models", { apiKey });
        else if (provider === "claude")
          result = await invoke<CloudModel[]>("get_anthropic_models", {
            apiKey,
          });
        else if (provider === "groq")
          result = await invoke<CloudModel[]>("get_groq_models", { apiKey });
        if (live)
          setRemoteModels(result.map((item) => item.id).filter(Boolean));
      } catch {
        if (live) setRemoteModels([]);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [open, provider]);

  const suggestions = useMemo(
    () =>
      provider === "builtin-ai"
        ? models.map((item) => item.name)
        : Array.from(
            new Set(
              [
                provider === modelConfig.provider ? modelConfig.model : "",
                ...remoteModels,
                ...(modelOptions[provider] || []),
              ].filter(Boolean),
            ),
          ),
    [
      provider,
      models,
      remoteModels,
      modelConfig.provider,
      modelConfig.model,
      modelOptions,
    ],
  );
  const changeProvider = (next: ModelConfig["provider"]) => {
    setProvider(next);
    setCustomModel(false);
    if (next === "builtin-ai") setModel(models[0]?.name || "");
    else
      setModel(
        next === modelConfig.provider
          ? modelConfig.model
          : modelOptions[next]?.[0] || "",
      );
  };
  const providerLabel = (value: ModelConfig["provider"]) =>
    value === "builtin-ai"
      ? zh
        ? "本地 AI"
        : "Local AI"
      : PROVIDERS.find((item) => item.value === value)?.label || value;

  const start = async () => {
    if (!model || starting || transcriptCount === 0) return;
    setStarting(true);
    try {
      await beforeStart?.();
      await invoke("api_start_local_transcript_refinement", {
        meetingId,
        language: language === "auto" ? null : language,
        provider,
        model,
        profile,
        useGlossary,
        allowCloudUpload: provider !== "builtin-ai" && provider !== "ollama",
      });
      const preferences: RefinementPreferences = {
        provider,
        model,
        language,
        profile,
        useGlossary,
        customModel,
      };
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      onStarted();
      onOpenChange(false);
      toast.info(
        provider === "builtin-ai" || provider === "ollama"
          ? zh
            ? "AI 文字稿优化已在本机后台开始"
            : "AI transcript optimization started locally in the background"
          : zh
            ? `文字稿已提交给 ${providerLabel(provider)}，优化将在后台继续`
            : `Transcript sent to ${provider}; optimization continues in the background`,
      );
    } catch (error) {
      toast.error(lt("AI transcript optimization failed"), {
        description: String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={starting ? undefined : onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[600px]">
        <DialogHeader className="border-b border-slate-100 px-6 pb-5 pt-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-violet-600" />
            {zh ? "AI 优化文字稿" : "AI transcript optimization"}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-[145px_1fr_160px] gap-4">
            <div className="grid gap-2">
              <Label>{zh ? "模型服务" : "AI provider"}</Label>
              <Select
                value={provider}
                onValueChange={(value) =>
                  changeProvider(value as ModelConfig["provider"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.filter(
                    (item) =>
                      configuredProviders.has(item.value) &&
                      (item.value !== "builtin-ai" ||
                        loadingModels ||
                        models.length > 0),
                  ).map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {providerLabel(item.value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-slate-400" />
                {zh ? "AI 模型" : "AI model"}
              </Label>
              {provider === "builtin-ai" ? (
                <Select
                  value={model}
                  onValueChange={setModel}
                  disabled={loadingModels || models.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        loadingModels
                          ? lt("Loading…")
                          : lt("No downloaded local model")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Select
                    value={customModel ? "__custom__" : model}
                    onValueChange={(value) => {
                      if (value === "__custom__") {
                        setCustomModel(true);
                        setModel("");
                      } else {
                        setCustomModel(false);
                        setModel(value);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={zh ? "选择模型" : "Select model"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {suggestions.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">
                        {zh ? "其他模型 ID…" : "Other model ID…"}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {customModel && (
                    <input
                      id={modelListId}
                      autoFocus
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder={zh ? "输入模型 ID" : "Enter model ID"}
                      className="h-9 rounded-md border border-input bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-violet-200"
                    />
                  )}
                </>
              )}
            </div>
            <div className="grid gap-2">
              <Label className="flex items-center gap-2">
                <Languages className="h-4 w-4 text-slate-400" />
                {zh ? "输出语言" : "Output language"}
              </Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {zh ? "保持原语言" : "Keep source language"}
                  </SelectItem>
                  <SelectItem value="zh">简体中文</SelectItem>
                  <SelectItem value="zh-tw">繁體中文</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {provider !== "builtin-ai" && provider !== "ollama" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
              {zh
                ? `隐私提示：本次完整文字稿、发言人信息，以及${useGlossary ? "已启用的热词和术语" : "必要上下文"}将发送给 ${providerLabel(provider)} 进行处理；原始音频和时间戳不会上传。点击“开始优化”即表示你明确允许本次发送；授权仅对本次任务有效。`
                : `Privacy notice: the full transcript, speaker labels, and relevant context will be sent to ${provider}. Audio and timestamps are not uploaded. Clicking Start optimization explicitly authorizes this task only.`}
            </div>
          )}

          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-slate-400" />
              {zh ? "优化方式" : "Optimization profile"}
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  [
                    "proofread",
                    zh ? "基础校对" : "Proofread",
                    zh
                      ? "最保守：标点、断句和确定错误"
                      : "Most conservative corrections",
                  ],
                  [
                    "faithful",
                    zh ? "忠实优化" : "Faithful",
                    zh
                      ? "推荐：接近专业录音笔优化稿"
                      : "Recommended professional transcript",
                  ],
                  [
                    "readable",
                    zh ? "易读文稿" : "Readable",
                    zh
                      ? "更书面化，但不摘要、不遗漏观点"
                      : "More polished, never summarized",
                  ],
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  key={item[0]}
                  onClick={() => setProfile(item[0])}
                  className={`rounded-xl border p-3 text-left transition ${profile === item[0] ? "border-violet-400 bg-violet-50 ring-1 ring-violet-200" : "border-slate-200 hover:border-violet-200"}`}
                >
                  <span className="block text-sm font-medium text-slate-700">
                    {item[1]}
                  </span>
                  <span className="mt-1 block text-[11px] leading-4 text-slate-400">
                    {item[2]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200">
            <label className="flex items-center justify-between gap-4 p-4">
              <span>
                <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <BookOpenText className="h-4 w-4 text-violet-500" />
                  {zh ? "使用热词和术语库" : "Use hotwords and glossary"}
                </span>
                <span className="mt-1 block text-xs text-slate-400">
                  {zh
                    ? "帮助修正人名、产品名、缩写和专业术语"
                    : "Helps correct names, products, acronyms, and domain terms"}
                </span>
              </span>
              <Switch checked={useGlossary} onCheckedChange={setUseGlossary} />
            </label>
            <div className="flex items-start gap-2 border-t border-slate-100 px-4 py-3 text-xs leading-5 text-slate-500">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>
                {zh
                  ? "事实保护始终开启：数字、日期、金额、否定词、责任人和低置信度修改不会被自动改写，将保留原文并标记待复核。"
                  : "Fact protection is always enabled. Risky changes to numbers, dates, negation, ownership, and uncertain terms preserve the source for review."}
              </span>
            </div>
          </div>

          {provider === "builtin-ai" &&
            !loadingModels &&
            models.length === 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-700">
                {zh
                  ? "请先在“设置 → 总结”中下载一个本地 AI 模型。"
                  : "Download a local AI model in Settings → Summary."}
              </div>
            )}
        </div>

        <DialogFooter className="border-t border-slate-100 px-6 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={starting}
          >
            {lt("Cancel")}
          </Button>
          <Button
            onClick={() => void start()}
            disabled={
              starting ||
              !configuredProviders.has(provider) ||
              (provider === "builtin-ai" && loadingModels) ||
              !model ||
              transcriptCount === 0
            }
            className="bg-violet-600 hover:bg-violet-700"
          >
            {starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {zh ? "开始优化" : "Start optimization"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
