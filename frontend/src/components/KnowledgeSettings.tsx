"use client";

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, BookText, Check, ChevronRight, FileUp, LayoutGrid, List, Loader2, Plus, Search, Tags, Trash2, UsersRound, X } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { PersonDetailView } from "@/components/PersonDetailView";
import { ProductButton, ProductEmptyState, ProductIconButton, ProductInput, ProductPanel, ProductSegmentedControl } from "@/components/ui/ProductControls";
import { ProductConfirmDialog } from "@/components/ui/ProductConfirmDialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type Person = { id: string; name: string; voiceprintCount: number; meetingCount: number; autoIdentify: boolean };
type Hotword = { id: string; term: string; category: string; enabled: boolean; usageCount: number; tags: string[] };
type LegacyPreview = { affectedRows: number; sourceDescription: string; sharedSourceIsReadOnly: boolean };
type Section = "people" | "terms";
type PendingConfirm = { kind: "people" | "terms" | "legacy"; ids?: string[]; count: number };

export function KnowledgeSettings() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [section, setSection] = useState<Section>("people");
  const [people, setPeople] = useState<Person[]>([]);
  const [hotwords, setHotwords] = useState<Hotword[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [personView, setPersonView] = useState<"list" | "cards">("list");
  const [personName, setPersonName] = useState("");
  const [term, setTerm] = useState("");
  const [termTag, setTermTag] = useState(zh ? "通用" : "General");
  const [tagFilter, setTagFilter] = useState("all");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedTerms, setSelectedTerms] = useState<Set<string>>(new Set());
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState("");
  const [tagDialog, setTagDialog] = useState(false);
  const [batchTag, setBatchTag] = useState("");
  const [legacy, setLegacy] = useState<LegacyPreview | null>(null);
  const [resolvingLegacy, setResolvingLegacy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [nextPeople, nextTerms, nextLegacy] = await Promise.all([
        invoke<Person[]>("api_list_people"),
        invoke<Hotword[]>("api_list_hotwords"),
        invoke<LegacyPreview>("api_preview_legacy_hotword_disposition"),
      ]);
      setPeople(nextPeople);
      setHotwords(nextTerms.map((item) => ({ ...item, tags: item.tags || [item.category].filter(Boolean) })));
      setLegacy(nextLegacy);
    } catch (error) {
      reportTechnicalError("knowledge-load", error);
      toast.error(zh ? "数据加载失败" : "Could not load data", { description: toUserFacingError(error, locale).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const saved = localStorage.getItem("calmeePeopleView");
    if (saved === "list" || saved === "cards") setPersonView(saved);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const visiblePeople = useMemo(() => people.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery)), [people, normalizedQuery]);
  const tags = useMemo(() => Array.from(new Set(hotwords.flatMap((item) => item.tags))).filter(Boolean).sort((a, b) => a.localeCompare(b)), [hotwords]);
  const visibleTerms = useMemo(() => hotwords.filter((item) =>
    (tagFilter === "all" || item.tags.includes(tagFilter))
    && (!normalizedQuery || item.term.toLowerCase().includes(normalizedQuery) || item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))),
  ), [hotwords, normalizedQuery, tagFilter]);
  const selectedTermRows = hotwords.filter((item) => selectedTerms.has(item.id));
  const activeForTag = visibleTerms.length > 0 && visibleTerms.every((item) => item.enabled);

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => setter((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const tagLabel = (tag: string) => {
    const labels: Record<string, [string, string]> = {
      "core company glossary": ["核心", "Core"],
      "meeting batch correction": ["纠错", "Correction"],
      people: ["人名", "People"],
      general: ["通用", "General"],
    };
    const label = labels[tag.trim().toLowerCase()];
    return label ? (zh ? label[0] : label[1]) : tag;
  };

  const addPerson = async () => {
    if (!personName.trim()) return;
    try {
      await invoke("api_create_person", { name: personName.trim() });
      setPersonName("");
      await load();
    } catch (error) {
      reportTechnicalError("knowledge-person-create", error);
      toast.error(zh ? "新建失败" : "Could not add person", { description: toUserFacingError(error, locale).message });
    }
  };
  const removePeople = async (ids: string[]) => {
    if (ids.length) setPendingConfirm({ kind: "people", ids, count: ids.length });
  };
  const addTerm = async () => {
    if (!term.trim()) return;
    try {
      await invoke("api_upsert_hotword", { term: term.trim(), replacementFrom: null, category: termTag.trim() || null });
      setTerm("");
      await load();
    } catch (error) {
      reportTechnicalError("knowledge-term-create", error);
      toast.error(zh ? "添加失败" : "Could not add term", { description: toUserFacingError(error, locale).message });
    }
  };
  const setEnabled = async (ids: string[], enabled: boolean) => {
    if (!ids.length) return;
    await invoke("api_set_hotwords_enabled", { ids, enabled });
    setSelectedTerms(new Set());
    await load();
  };
  const removeTerms = async (ids: string[]) => {
    if (ids.length) setPendingConfirm({ kind: "terms", ids, count: ids.length });
  };
  const importBulk = async () => {
    if (!bulk.trim()) return;
    const count = await invoke<number>("api_import_hotwords", { content: bulk });
    toast.success(zh ? `已导入 ${count} 个词` : `Imported ${count} terms`);
    setBulk("");
    setBulkOpen(false);
    await load();
  };
  const addBatchTag = async () => {
    const tag = batchTag.trim();
    if (!tag || !selectedTermRows.length) return;
    await Promise.all(selectedTermRows.map((item) => invoke("api_set_hotwords_tags", { ids: [item.id], tags: Array.from(new Set([...item.tags, tag])) })));
    setBatchTag("");
    setTagDialog(false);
    await load();
  };
  const resolveLegacy = async (action: "keep" | "delete") => {
    if (!legacy?.affectedRows || resolvingLegacy) return;
    if (action === "delete") {
      setPendingConfirm({ kind: "legacy", count: legacy.affectedRows });
      return;
    }
    setResolvingLegacy(true);
    try {
      await invoke("api_apply_legacy_hotword_disposition", { disposition: { action, expectedRows: legacy.affectedRows, confirmed: true } });
      toast.success(action === "keep" ? (zh ? "已保留这批词库" : "Legacy terms kept") : (zh ? "已删除这批旧词库" : "Legacy terms removed"));
      await load();
    } catch (error) {
      reportTechnicalError("knowledge-legacy-resolution", error);
      toast.error(zh ? "处置失败，未更改任何记录" : "No records were changed", { description: toUserFacingError(error, locale).message });
    } finally {
      setResolvingLegacy(false);
    }
  };

  const executePendingConfirm = async () => {
    if (!pendingConfirm) return;
    setConfirming(true);
    try {
      if (pendingConfirm.kind === "people") {
        await Promise.all((pendingConfirm.ids || []).map((personId) => invoke("api_delete_person", { personId })));
        setSelectedPeople(new Set());
      } else if (pendingConfirm.kind === "terms") {
        await invoke("api_delete_hotwords", { ids: pendingConfirm.ids || [] });
        setSelectedTerms(new Set());
      } else if (legacy?.affectedRows) {
        await invoke("api_apply_legacy_hotword_disposition", { disposition: { action: "delete", expectedRows: legacy.affectedRows, confirmed: true } });
        toast.success(zh ? "已删除这批旧词库" : "Legacy terms removed");
      }
      setPendingConfirm(null);
      await load();
    } catch (error) {
      reportTechnicalError("knowledge-delete", error);
      toast.error(zh ? "删除失败，未更改相关记录" : "Delete failed; related records were not changed", { description: toUserFacingError(error, locale).message });
    } finally {
      setConfirming(false);
    }
  };

  if (selectedPerson) return <PersonDetailView personId={selectedPerson} onBack={() => { setSelectedPerson(null); void load(); }} />;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <ProductSegmentedControl
          value={section}
          onChange={(value) => { setSection(value); setQuery(""); }}
          ariaLabel={zh ? "数据类型" : "Data type"}
          options={[
            { value: "people", label: zh ? "人员与声纹" : "People" },
            { value: "terms", label: zh ? "转写词库" : "Vocabulary" },
          ]}
        />
        <div className="flex items-center gap-2">
          {section === "people" && (
            <div className="flex h-9 items-center rounded-lg border border-border/80 bg-muted/45 p-0.5">
              <ProductIconButton active={personView === "list"} onClick={() => { setPersonView("list"); localStorage.setItem("calmeePeopleView", "list"); }} aria-label={zh ? "列表" : "List"}><List className="h-4 w-4" /></ProductIconButton>
              <ProductIconButton active={personView === "cards"} onClick={() => { setPersonView("cards"); localStorage.setItem("calmeePeopleView", "cards"); }} aria-label={zh ? "卡片" : "Cards"}><LayoutGrid className="h-4 w-4" /></ProductIconButton>
            </div>
          )}
          <label className="relative block w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <ProductInput value={query} onChange={(event) => setQuery(event.target.value)} className="w-full pl-9" placeholder={section === "people" ? (zh ? "搜索人员" : "Search people") : (zh ? "搜索词语或标签" : "Search terms or tags")} />
          </label>
        </div>
      </div>

      {loading ? (
        <ProductPanel className="grid min-h-[430px] place-items-center">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{zh ? "正在加载数据" : "Loading data"}</div>
        </ProductPanel>
      ) : section === "people" ? (
        <ProductPanel>
          <div className="flex min-h-12 items-center gap-2 border-b border-border/70 px-4 py-2">
            <ProductInput value={personName} onChange={(event) => setPersonName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addPerson()} className="w-52" placeholder={zh ? "人员姓名" : "Person name"} />
            <ProductButton size="sm" variant="primary" onClick={() => void addPerson()} disabled={!personName.trim()}><Plus className="h-4 w-4" />{zh ? "新建人员" : "Add person"}</ProductButton>
            {selectedPeople.size > 0 && (
              <div className="ml-auto flex items-center gap-1">
                <span className="mr-2 text-[11px] text-muted-foreground">{zh ? `已选择 ${selectedPeople.size} 位` : `${selectedPeople.size} selected`}</span>
                <ProductButton size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void removePeople([...selectedPeople])}><Trash2 className="h-3.5 w-3.5" />{zh ? "删除" : "Delete"}</ProductButton>
                <ProductIconButton onClick={() => setSelectedPeople(new Set())} aria-label={zh ? "清除选择" : "Clear selection"}><X className="h-3.5 w-3.5" /></ProductIconButton>
              </div>
            )}
          </div>
          {!visiblePeople.length ? (
            <ProductEmptyState
              icon={<UsersRound className="h-5 w-5" />}
              title={query ? (zh ? "没有匹配的人员" : "No matching people") : (zh ? "还没有人员资料" : "No people yet")}
              description={query ? (zh ? "尝试使用其他姓名搜索。" : "Try another name.") : (zh ? "添加常见参会人后，可以逐步积累声纹并改善说话人识别。" : "Add frequent participants to build voiceprints and improve speaker recognition.")}
              action={query ? <ProductButton size="sm" onClick={() => setQuery("")}>{zh ? "清除搜索" : "Clear search"}</ProductButton> : undefined}
            />
          ) : personView === "list" ? (
            <PeopleList zh={zh} people={visiblePeople} selected={selectedPeople} onToggle={(id) => toggle(setSelectedPeople, id)} onOpen={setSelectedPerson} />
          ) : (
            <PeopleCards zh={zh} people={visiblePeople} selected={selectedPeople} onToggle={(id) => toggle(setSelectedPeople, id)} onOpen={setSelectedPerson} />
          )}
          <footer className="flex h-9 items-center border-t border-border/60 bg-muted/25 px-4 text-[10px] text-muted-foreground">{zh ? `${people.length} 位人员` : `${people.length} people`}</footer>
        </ProductPanel>
      ) : (
        <div className="space-y-3">
          {!!legacy?.affectedRows && (
            <aside className="rounded-xl border border-amber-200/80 bg-amber-50/85 p-4 text-[11px] leading-5 text-amber-950">
              <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div className="min-w-0 flex-1">
                <p className="font-semibold">{zh ? `检测到 ${legacy.affectedRows} 条曾从共享 FunASR 配置复制的词库` : `${legacy.affectedRows} terms were copied from a shared FunASR configuration`}</p>
                <p className="mt-1 text-amber-800">{zh ? "共享配置始终只读。默认不会处理；你可以保留这些词，或只删除严格匹配来源的记录。" : "The shared configuration stays read-only. Keep these terms, or remove only strictly matched records."}</p>
                <div className="mt-3 flex gap-2"><ProductButton size="sm" disabled={resolvingLegacy} onClick={() => void resolveLegacy("keep")}>{zh ? "保留这批词" : "Keep terms"}</ProductButton><ProductButton size="sm" variant="danger" disabled={resolvingLegacy} onClick={() => void resolveLegacy("delete")}>{zh ? "删除旧词库" : "Remove legacy terms"}</ProductButton></div>
              </div></div>
            </aside>
          )}
          <ProductPanel>
            <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-2">
              <FilterButton active={tagFilter === "all"} onClick={() => setTagFilter("all")}>{zh ? "全部" : "All"}</FilterButton>
              {tags.map((tag) => <FilterButton key={tag} active={tagFilter === tag} onClick={() => setTagFilter(tag)}>{tagLabel(tag)}</FilterButton>)}
              <span className="ml-auto text-[10px] text-muted-foreground">{tagFilter === "all" ? (zh ? "全部词库" : "All terms") : tagLabel(tagFilter)}</span>
              <Toggle enabled={activeForTag} onClick={() => void setEnabled(visibleTerms.map((item) => item.id), !activeForTag)} />
            </div>
            <div className="flex min-h-12 items-center gap-2 border-b border-border/70 px-4 py-2">
              <ProductInput value={term} onChange={(event) => setTerm(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addTerm()} className="w-56" placeholder={zh ? "添加新词" : "Add a term"} />
              <ProductInput value={termTag} onChange={(event) => setTermTag(event.target.value)} className="w-32" placeholder={zh ? "标签" : "Tag"} />
              <ProductButton size="sm" variant="primary" onClick={() => void addTerm()} disabled={!term.trim()}><Plus className="h-4 w-4" />{zh ? "添加" : "Add"}</ProductButton>
              <ProductButton size="sm" variant="ghost" onClick={() => setBulkOpen((value) => !value)}><FileUp className="h-4 w-4" />{zh ? "批量导入" : "Import"}</ProductButton>
              {selectedTerms.size > 0 && (
                <div className="ml-auto flex items-center gap-1"><span className="mr-1 text-[10px] text-muted-foreground">{zh ? `${selectedTerms.size} 项` : `${selectedTerms.size} selected`}</span>
                  <ProductButton size="sm" variant="ghost" onClick={() => void setEnabled([...selectedTerms], true)}>{zh ? "启用" : "Enable"}</ProductButton>
                  <ProductButton size="sm" variant="ghost" onClick={() => void setEnabled([...selectedTerms], false)}>{zh ? "停用" : "Disable"}</ProductButton>
                  <ProductButton size="sm" variant="ghost" onClick={() => setTagDialog(true)}>{zh ? "增加标签" : "Add tag"}</ProductButton>
                  <ProductButton size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void removeTerms([...selectedTerms])}>{zh ? "删除" : "Delete"}</ProductButton>
                  <ProductIconButton onClick={() => setSelectedTerms(new Set())} aria-label={zh ? "清除选择" : "Clear selection"}><X className="h-3.5 w-3.5" /></ProductIconButton>
                </div>
              )}
            </div>
            {bulkOpen && <div className="flex gap-3 border-b border-border/70 bg-muted/25 p-4"><textarea value={bulk} onChange={(event) => setBulk(event.target.value)} className="min-h-24 min-w-0 flex-1 resize-y rounded-lg border border-input bg-card p-3 text-[12px] leading-5 outline-none transition focus:border-primary/70 focus:ring-2 focus:ring-primary/15" placeholder={zh ? "每行一个词；也支持“词 频次”" : "One term per line; “term frequency” is supported"} /><ProductButton size="sm" variant="primary" className="self-end" onClick={() => void importBulk()} disabled={!bulk.trim()}>{zh ? "导入" : "Import"}</ProductButton></div>}
            {!visibleTerms.length ? (
              <ProductEmptyState icon={<BookText className="h-5 w-5" />} title={hotwords.length ? (zh ? "没有匹配的词" : "No matching terms") : (zh ? "词库还是空的" : "Vocabulary is empty")} description={hotwords.length ? (zh ? "调整搜索内容或标签筛选。" : "Adjust the search or tag filter.") : (zh ? "添加产品名、人名和专业术语，可以减少转写中的专有名词错误。" : "Add product names, people, and specialist terms to improve transcription accuracy.")} action={hotwords.length ? <ProductButton size="sm" onClick={() => setQuery("")}>{zh ? "清除搜索" : "Clear search"}</ProductButton> : undefined} />
            ) : (
              <TermsList zh={zh} terms={visibleTerms} selected={selectedTerms} tagLabel={tagLabel} onTag={setTagFilter} onToggle={(id) => toggle(setSelectedTerms, id)} onToggleAll={() => setSelectedTerms(visibleTerms.every((item) => selectedTerms.has(item.id)) ? new Set() : new Set(visibleTerms.map((item) => item.id)))} onEnabled={setEnabled} onRemove={removeTerms} />
            )}
            <footer className="flex h-9 items-center border-t border-border/60 bg-muted/25 px-4 text-[10px] text-muted-foreground">{zh ? `显示 ${visibleTerms.length} / ${hotwords.length} 个词` : `Showing ${visibleTerms.length} of ${hotwords.length}`}</footer>
          </ProductPanel>
        </div>
      )}

      <Dialog open={tagDialog} onOpenChange={setTagDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Tags className="h-4 w-4 text-primary" />{zh ? "为所选词增加标签" : "Add tag to selected terms"}</DialogTitle></DialogHeader>
          <ProductInput autoFocus value={batchTag} onChange={(event) => setBatchTag(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void addBatchTag()} className="w-full" placeholder={zh ? "输入简短标签" : "Short tag"} />
          <DialogFooter><ProductButton size="sm" onClick={() => setTagDialog(false)}>{zh ? "取消" : "Cancel"}</ProductButton><ProductButton size="sm" variant="primary" onClick={() => void addBatchTag()} disabled={!batchTag.trim()}>{zh ? "增加" : "Add"}</ProductButton></DialogFooter>
        </DialogContent>
      </Dialog>

      <ProductConfirmDialog
        open={!!pendingConfirm}
        onOpenChange={(open) => !open && setPendingConfirm(null)}
        title={pendingConfirm?.kind === "people" ? (zh ? "删除人员资料" : "Delete people") : pendingConfirm?.kind === "legacy" ? (zh ? "删除旧词库" : "Remove legacy terms") : (zh ? "删除词语" : "Delete terms")}
        description={pendingConfirm?.kind === "people" ? (zh ? `将删除 ${pendingConfirm?.count || 0} 位人员及其声纹资料。` : `Delete ${pendingConfirm?.count || 0} people and their voiceprints.`) : pendingConfirm?.kind === "legacy" ? (zh ? `只从当前数据库删除 ${pendingConfirm?.count || 0} 条严格匹配来源的旧词库。` : `Remove ${pendingConfirm?.count || 0} strictly matched legacy terms from the current database.`) : (zh ? `将删除 ${pendingConfirm?.count || 0} 个词。` : `Delete ${pendingConfirm?.count || 0} terms.`)}
        details={pendingConfirm?.kind === "legacy" ? (zh ? "共享 FunASR 配置文件始终只读，不会被修改。" : "The shared FunASR configuration remains read-only and will not be changed.") : undefined}
        confirmLabel={zh ? "确认删除" : "Delete"}
        cancelLabel={zh ? "取消" : "Cancel"}
        destructive
        loading={confirming}
        onConfirm={executePendingConfirm}
      />
    </section>
  );
}

function PeopleList({ zh, people, selected, onToggle, onOpen }: { zh: boolean; people: Person[]; selected: Set<string>; onToggle: (id: string) => void; onOpen: (id: string) => void }) {
  return <div className="max-h-[560px] overflow-y-auto"><div className="sticky top-0 z-10 grid grid-cols-[44px_minmax(180px,1fr)_110px_110px_130px_28px] items-center border-b border-border/70 bg-muted/35 px-4 py-2 text-[10px] font-medium text-muted-foreground"><span /><span>{zh ? "姓名" : "Name"}</span><span>{zh ? "会议" : "Meetings"}</span><span>{zh ? "有效声纹" : "Voiceprints"}</span><span>{zh ? "识别状态" : "Recognition"}</span><span /></div>{people.map((person) => <div key={person.id} className="group grid grid-cols-[44px_minmax(180px,1fr)_110px_110px_130px_28px] items-center border-b border-border/55 px-4 py-2.5 transition hover:bg-accent/55"><Selection selected={selected.has(person.id)} onClick={() => onToggle(person.id)} /><button onClick={() => onOpen(person.id)} className="flex min-w-0 items-center gap-3 text-left"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[11px] font-semibold text-primary">{person.name.slice(-2)}</span><span className="truncate text-[13px] font-medium">{person.name}</span></button><span className="text-[12px] tabular-nums text-muted-foreground">{person.meetingCount}</span><span className="text-[12px] tabular-nums text-muted-foreground">{person.voiceprintCount}</span><span className={person.voiceprintCount && person.autoIdentify ? "text-[11px] text-emerald-600" : "text-[11px] text-muted-foreground"}>{person.voiceprintCount ? (person.autoIdentify ? (zh ? "可自动识别" : "Ready") : (zh ? "已暂停" : "Paused")) : (zh ? "等待样本" : "No sample")}</span><ProductIconButton onClick={() => onOpen(person.id)} className="opacity-0 group-hover:opacity-100" aria-label={zh ? "查看人员" : "View person"}><ChevronRight className="h-4 w-4" /></ProductIconButton></div>)}</div>;
}

function PeopleCards({ zh, people, selected, onToggle, onOpen }: { zh: boolean; people: Person[]; selected: Set<string>; onToggle: (id: string) => void; onOpen: (id: string) => void }) {
  return <div className="grid max-h-[590px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 overflow-y-auto bg-muted/25 p-4">{people.map((person) => <article key={person.id} className="group relative rounded-xl border border-border/75 bg-card p-4 transition hover:border-primary/25 hover:shadow-[0_10px_28px_hsl(var(--primary)/0.08)]"><div className="absolute right-3 top-3"><Selection selected={selected.has(person.id)} onClick={() => onToggle(person.id)} /></div><button onClick={() => onOpen(person.id)} className="w-full text-left"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-[12px] font-semibold text-primary">{person.name.slice(-2)}</span><div className="mt-3 flex items-center"><span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{person.name}</span><ChevronRight className="h-4 w-4 text-muted-foreground/50" /></div><div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/55 pt-3 text-[10px] text-muted-foreground"><span><strong className="mr-1 text-[13px] font-medium tabular-nums text-foreground">{person.meetingCount}</strong>{zh ? "会议" : "meetings"}</span><span><strong className="mr-1 text-[13px] font-medium tabular-nums text-foreground">{person.voiceprintCount}</strong>{zh ? "声纹" : "voiceprints"}</span></div></button></article>)}</div>;
}

function TermsList({ zh, terms, selected, tagLabel, onTag, onToggle, onToggleAll, onEnabled, onRemove }: { zh: boolean; terms: Hotword[]; selected: Set<string>; tagLabel: (tag: string) => string; onTag: (tag: string) => void; onToggle: (id: string) => void; onToggleAll: () => void; onEnabled: (ids: string[], enabled: boolean) => Promise<void>; onRemove: (ids: string[]) => Promise<void> }) {
  const allSelected = terms.length > 0 && terms.every((item) => selected.has(item.id));
  return <div className="max-h-[540px] overflow-y-auto"><div className="sticky top-0 z-10 grid grid-cols-[44px_minmax(240px,5fr)_minmax(140px,2fr)_minmax(90px,1fr)_minmax(90px,1fr)_34px] items-center border-b border-border/70 bg-muted/35 px-4 py-2 text-[10px] font-medium text-muted-foreground"><Selection selected={allSelected} onClick={onToggleAll} /><span>{zh ? "词语" : "Term"}</span><span>{zh ? "标签" : "Tags"}</span><span className="text-center">{zh ? "词频" : "Frequency"}</span><span className="text-center">{zh ? "状态" : "Status"}</span><span /></div>{terms.map((item) => <div key={item.id} className="group grid grid-cols-[44px_minmax(240px,5fr)_minmax(140px,2fr)_minmax(90px,1fr)_minmax(90px,1fr)_34px] items-center border-b border-border/55 px-4 py-2.5 transition hover:bg-accent/55"><Selection selected={selected.has(item.id)} onClick={() => onToggle(item.id)} /><span className="truncate text-[12px] font-medium">{item.term}</span><span className="flex min-w-0 flex-wrap gap-1">{item.tags.slice(0, 4).map((tag) => <button key={tag} type="button" onClick={() => onTag(tag)} className="rounded-md bg-muted px-2 py-0.5 text-[9px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground">{tagLabel(tag)}</button>)}</span><span className="text-center text-[11px] tabular-nums text-muted-foreground">{item.usageCount || "—"}</span><Toggle enabled={item.enabled} className="justify-self-center" onClick={() => void onEnabled([item.id], !item.enabled)} /><ProductIconButton onClick={() => void onRemove([item.id])} className="text-destructive opacity-0 group-hover:opacity-100" aria-label={zh ? "删除词语" : "Delete term"}><Trash2 className="h-3.5 w-3.5" /></ProductIconButton></div>)}</div>;
}

function Selection({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={selected ? "flex h-4 w-4 items-center justify-center rounded-[5px] border border-primary bg-primary text-primary-foreground transition" : "flex h-4 w-4 items-center justify-center rounded-[5px] border border-input bg-card text-transparent transition hover:border-primary/55"}><Check className="h-3 w-3" /></button>;
}
function FilterButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={active ? "rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground transition" : "rounded-md bg-muted px-2.5 py-1 text-[10px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"}>{children}</button>;
}
function Toggle({ enabled, onClick, className = "" }: { enabled: boolean; onClick: () => void; className?: string }) {
  return <button type="button" onClick={onClick} className={`${enabled ? "bg-emerald-500" : "bg-muted-foreground/25"} relative h-5 w-9 rounded-full transition ${className}`}><span className={`${enabled ? "translate-x-[18px]" : "translate-x-0.5"} absolute left-0 top-0.5 h-4 w-4 rounded-full bg-card shadow-sm transition-transform`} /></button>;
}
