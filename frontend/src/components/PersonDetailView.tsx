"use client";

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, AudioLines, CalendarDays, ChevronRight, FileText, Loader2, Save, Sparkles, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { openMeetingWorkspace } from "@/lib/meeting-window";
import { Button } from "@/components/ui/button";
import { PersonProfileGenerationDialog } from "@/components/PersonProfileGenerationDialog";
import { ProgressIconButton } from "@/components/MeetingWorkspace/ProgressIconButton";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type ProfileEvidence={meeting:string;time:string;quote:string};
type ProfileItem={trait:string;observation:string;confidence:"low"|"medium"|"high";evidence:ProfileEvidence[]};
type SpeakingProfile={overview:string;communicationStyle:ProfileItem[];discussionPatterns:ProfileItem[];decisionAndActionStyle:ProfileItem[];behavioralTendencies:ProfileItem[];personalityHypotheses:ProfileItem[];uncertainties:string[];dataCoverage?:{note?:string};generatedAt?:string;provider?:string;model?:string;meetingCount?:number;statementCount?:number;status?:string};
type ProfileJob={status:string;progress?:{percentage?:number;stage?:string;message?:string};error?:string};

type PersonDetail = {
  person: { id:string; name:string; autoIdentify:boolean; voiceprintCount:number; meetingCount:number };
  aliases:string[];
  notes?:string;
  profileContext?:string;
  profileJson?:SpeakingProfile;
  profileUpdatedAt?:string;
  voiceprints:Array<{id:string;sourceMeetingId?:string;sourceMeetingTitle?:string;sourceSpeaker?:string;quality:number;sampleDuration:number;status:string;confirmationSource:string;createdAt:string}>;
  meetings:Array<{id:string;title:string;startAt?:string;utteranceCount:number}>;
  utterances:Array<{transcriptId:string;meetingId:string;meetingTitle:string;startMs:number;endMs:number;text:string;sourceKind:string}>;
};
type DetailTab="profile"|"voiceprints"|"meetings"|"utterances";

const field="w-full rounded-md border border-black/15 bg-white px-3 text-[13px] text-slate-700 outline-none focus:border-[#0a84ff] focus:ring-2 focus:ring-blue-100";
const clock=(ms:number)=>`${String(Math.floor(ms/3600000)).padStart(2,"0")}:${String(Math.floor(ms/60000)%60).padStart(2,"0")}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}`;

export function PersonDetailView({personId,onBack}:{personId:string;onBack:()=>void}){
  const {locale}=useLanguage();
  const zh=locale==="zh-CN";
  const [detail,setDetail]=useState<PersonDetail|null>(null);
  // The first public alpha defaults to auditable identity and voiceprint management.
  const [tab,setTab]=useState<DetailTab>("voiceprints");
  const [aliases,setAliases]=useState("");
  const [notes,setNotes]=useState("");
  const [context,setContext]=useState("");
  const [saving,setSaving]=useState(false);
  const [profileOpen,setProfileOpen]=useState(false);
  const [profileJob,setProfileJob]=useState<ProfileJob>({status:"idle"});
  const [profilePollKey,setProfilePollKey]=useState(0);
  const load=async()=>{
    try{
      const value=await invoke<PersonDetail>("api_get_person_detail",{personId});
      setDetail(value);setAliases(value.aliases.join("、"));setNotes(value.notes||"");setContext(value.profileContext||"");
    }catch(error){reportTechnicalError("person-detail-load",error);toast.error(zh?"人员档案加载失败":"Could not load person",{description:toUserFacingError(error,locale).message});}
  };
  useEffect(()=>{void load();},[personId]);
  useEffect(()=>{
    let active=true; let timer:number|undefined;
    const poll=async()=>{try{
      const job=await invoke<ProfileJob>("api_get_person_profile_status",{personId});
      if(!active)return;setProfileJob(job);
      if(job.status==="processing")timer=window.setTimeout(()=>void poll(),1800);
      else if(job.status==="completed")await load();
    }catch(error){console.warn("Could not restore person-profile task",error);}};
    void poll();return()=>{active=false;if(timer)window.clearTimeout(timer);};
  },[personId,profilePollKey]);
  const profileRunning=profileJob.status==="processing";
  const profileProgressText=profileJob.progress?.stage==="validating"?(zh?"正在核验证据":"Verifying evidence"):profileJob.progress?.stage==="saving"?(zh?"正在保存画像":"Saving profile"):profileJob.progress?.stage==="preparing"?(zh?"正在准备发言":"Preparing statements"):(zh?"正在分析长期发言模式":"Analyzing speaking patterns");
  const cancelProfile=async()=>{try{await invoke("api_cancel_person_profile",{personId});setProfileJob({status:"cancelled"});toast.info(zh?"已停止人物画像生成":"Profile generation stopped");}catch(error){reportTechnicalError("person-profile-cancel",error);toast.error(zh?"停止失败":"Could not stop",{description:toUserFacingError(error,locale).message});}};
  const groupedUtterances=useMemo(()=>{
    const groups=new Map<string,PersonDetail["utterances"]>();
    for(const item of detail?.utterances||[]){const list=groups.get(item.meetingId)||[];list.push(item);groups.set(item.meetingId,list);}
    return [...groups.entries()];
  },[detail]);
  const save=async()=>{
    if(!detail)return;setSaving(true);
    try{
      await invoke("api_update_person_profile",{personId,aliases:aliases.split(/[、,，\n]/).map(item=>item.trim()).filter(Boolean),notes:notes.trim()||null,profileContext:context.trim()||null});
      toast.success(zh?"人员档案已保存":"Person saved");await load();
    }catch(error){reportTechnicalError("person-detail-save",error);toast.error(zh?"保存失败":"Save failed",{description:toUserFacingError(error,locale).message});}finally{setSaving(false);}
  };
  if(!detail)return <div className="flex min-h-[420px] items-center justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin"/></div>;
  const sourceLabel=(kind:string)=>kind==="ai_optimized"?(zh?"AI 优化稿":"AI optimized"):kind==="clustered"?(zh?"聚类稿":"Clustered"):(zh?"原始文稿":"Original");
  const tabs:Array<[DetailTab,string,typeof UserRound,number?]>=[
    ["voiceprints",zh?"声纹样本":"Voiceprints",AudioLines,detail.voiceprints.length],
    ["meetings",zh?"参加的会议":"Meetings",CalendarDays,detail.meetings.length],
    ["utterances",zh?"发言记录":"Statements",FileText,detail.utterances.length],
  ];
  const profile=detail.profileJson;
  const profileSection=(title:string,items:ProfileItem[]|undefined)=>items?.length?<section className="border-t border-black/[0.06] py-3 first:border-0 first:pt-0"><h4 className="mb-2 text-[11px] font-semibold text-slate-500">{title}</h4><div className="space-y-3">{items.map((item,index)=><div key={`${item.trait}-${index}`}><div className="flex items-center gap-2"><span className="text-[12px] font-semibold text-slate-700">{item.trait}</span><span className={`rounded-full px-1.5 py-0.5 text-[9px] ${item.confidence==="high"?"bg-emerald-50 text-emerald-700":item.confidence==="medium"?"bg-amber-50 text-amber-700":"bg-slate-100 text-slate-500"}`}>{item.confidence==="high"?(zh?"高":"High"):item.confidence==="medium"?(zh?"中":"Medium"):(zh?"初步":"Preliminary")}</span></div><p className="mt-1 text-[12px] leading-5 text-slate-600">{item.observation}</p>{item.evidence?.length>0&&<div className="mt-1.5 space-y-1">{item.evidence.map((evidence,evidenceIndex)=><div key={evidenceIndex} className="rounded-md bg-[#f6f6f7] px-2.5 py-1.5 text-[10px] leading-4 text-slate-500"><span className="font-medium text-slate-600">{evidence.meeting} · {evidence.time}</span><span className="ml-1">“{evidence.quote}”</span></div>)}</div>}</div>)}</div></section>:null;
  return <div className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
    <header className="flex min-h-[76px] items-center gap-3 border-b border-black/[0.08] bg-[#f8f8f8] px-4">
      <button onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-black/[0.06]"><ArrowLeft className="h-4 w-4"/></button>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-violet-100 text-[14px] font-semibold text-violet-700">{detail.person.name.slice(-2)}</span>
      <div className="min-w-0"><h2 className="truncate text-[17px] font-semibold text-slate-800">{detail.person.name}</h2><div className="mt-0.5 text-[11px] text-slate-400">{zh?`${detail.meetings.length} 场会议 · ${detail.voiceprints.filter(item=>item.status==="confirmed"||item.status==="trusted").length} 个有效声纹`:`${detail.meetings.length} meetings · ${detail.voiceprints.length} voiceprints`}</div></div>
      <Button variant="outline" size="icon" onClick={()=>void save()} disabled={saving} className="ml-auto h-9 w-9 text-slate-600" title={zh?"保存人员档案":"Save person profile"}>{saving?<Loader2 className="h-4 w-4 animate-spin"/>:<Save className="h-4 w-4"/>}</Button>
    </header>
    <nav className="flex h-10 items-end gap-5 border-b border-black/[0.08] px-5">{tabs.map(([id,label,Icon,count])=><button key={id} onClick={()=>setTab(id)} className={`flex h-10 items-center gap-1.5 border-b-2 px-0.5 text-[12px] ${tab===id?"border-[#0a84ff] font-medium text-[#0071e3]":"border-transparent text-slate-500 hover:text-slate-700"}`}><Icon className="h-3.5 w-3.5"/>{label}{count!==undefined&&<span className="rounded-full bg-black/[0.05] px-1.5 text-[10px] text-slate-500">{count}</span>}</button>)}</nav>
    <div className="min-h-[500px] bg-[#f5f5f7] p-5">
      {tab==="profile"&&<div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-black/[0.08] bg-white p-4 shadow-sm"><h3 className="text-[13px] font-semibold">{zh?"身份与背景":"Identity & context"}</h3><p className="mt-1 text-[11px] leading-4 text-slate-400">{zh?"只保存你明确提供的信息，不由 AI 猜测。":"Only stores facts you explicitly provide."}</p><label className="mt-4 block text-[11px] text-slate-500">{zh?"别名":"Aliases"}<input value={aliases} onChange={event=>setAliases(event.target.value)} className={`${field} mt-1 h-9`} placeholder={zh?"用顿号分隔":"Separate with commas"}/></label><label className="mt-3 block text-[11px] text-slate-500">{zh?"身份、单位、职务及其他背景":"Identity, organization, role and context"}<textarea value={context} onChange={event=>setContext(event.target.value)} className={`${field} mt-1 min-h-32 resize-y py-2 leading-5`}/></label><label className="mt-3 block text-[11px] text-slate-500">{zh?"备注":"Notes"}<textarea value={notes} onChange={event=>setNotes(event.target.value)} className={`${field} mt-1 min-h-20 resize-y py-2 leading-5`}/></label></section>
        <section className="rounded-xl border border-black/[0.08] bg-white p-4 shadow-sm"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-500"/><h3 className="text-[13px] font-semibold">{zh?"长期发言画像":"Long-term speaking profile"}</h3><div className="ml-auto"><ProgressIconButton icon={<Sparkles className="h-4 w-4"/>} title={profile?(zh?"重新生成画像":"Regenerate profile"):(zh?"AI 生成人物画像":"Generate profile with AI")} onClick={()=>setProfileOpen(true)} onCancel={()=>void cancelProfile()} disabled={!detail.utterances.length} progress={profileRunning?(profileJob.progress?.percentage??5):null} progressText={profileProgressText} tone="ai"/></div></div><p className="mt-1 text-[11px] leading-4 text-slate-400">{zh?"画像区分语言风格、讨论习惯和行为倾向，每项结论保留会议证据。":"Language and behavioral patterns retain meeting evidence."}</p>{profile?<div className="mt-4"><div className="rounded-lg bg-violet-50/70 px-3 py-2.5 text-[12px] leading-5 text-violet-900">{profile.overview}</div><div className="mt-3">{profileSection(zh?"语言与沟通风格":"Communication style",profile.communicationStyle)}{profileSection(zh?"讨论习惯":"Discussion patterns",profile.discussionPatterns)}{profileSection(zh?"决策与行动风格":"Decision and action",profile.decisionAndActionStyle)}{profileSection(zh?"行为倾向":"Behavioral tendencies",profile.behavioralTendencies)}{profileSection(zh?"谨慎性格假设":"Cautious personality hypotheses",profile.personalityHypotheses)}</div>{profile.uncertainties?.length>0&&<div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[10px] leading-4 text-amber-800"><span className="font-semibold">{zh?"不确定性：":"Uncertainty: "}</span>{profile.uncertainties.join(zh?"；":"; ")}</div>}<div className="mt-3 text-[9px] text-slate-400">{profile.status==="preliminary"?(zh?"初步画像":"Preliminary profile"):(zh?"长期画像":"Longitudinal profile")} · {profile.meetingCount||detail.meetings.length} {zh?"场会议":"meetings"}{profile.generatedAt?` · ${new Date(profile.generatedAt).toLocaleString()}`:""}</div></div>:<div className="mt-8 rounded-lg border border-dashed border-black/10 px-4 py-10 text-center text-[12px] text-slate-400">{detail.utterances.length?(zh?"点击 AI 按钮选择本地或云端模型生成画像。":"Choose a local or cloud model with the AI button."):(zh?"没有已确认的发言，暂时无法生成画像。":"No confirmed statements are available.")}</div>}</section>
      </div>}
      {tab==="voiceprints"&&<section className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm"><div className="grid grid-cols-[minmax(0,1fr)_90px_90px_110px] border-b border-black/[0.07] bg-[#fafafa] px-4 py-2 text-[10px] font-medium text-slate-400"><span>{zh?"来源":"Source"}</span><span>{zh?"质量":"Quality"}</span><span>{zh?"时长":"Duration"}</span><span>{zh?"状态":"Status"}</span></div>{detail.voiceprints.map(item=><div key={item.id} className="grid grid-cols-[minmax(0,1fr)_90px_90px_110px] items-center border-b border-black/[0.06] px-4 py-3 text-[12px] last:border-0"><span className="min-w-0"><span className="block truncate font-medium text-slate-700">{item.sourceMeetingTitle||(zh?"未知会议":"Unknown meeting")}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{item.sourceSpeaker||"—"}</span></span><span className="text-slate-600">{Math.round(item.quality*100)}%</span><span className="text-slate-500">{item.sampleDuration.toFixed(1)}s</span><span><span className={`rounded-full px-2 py-1 text-[10px] ${item.status==="confirmed"||item.status==="trusted"?"bg-emerald-50 text-emerald-700":"bg-slate-100 text-slate-500"}`}>{item.status}</span></span></div>)}{!detail.voiceprints.length&&<div className="py-16 text-center text-[12px] text-slate-400">{zh?"还没有声纹样本":"No voiceprints"}</div>}</section>}
      {tab==="meetings"&&<section className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm">{detail.meetings.map(item=><button key={item.id} onClick={()=>void openMeetingWorkspace(item.id,url=>{window.location.href=url},{title:item.title})} className="flex w-full items-center gap-3 border-b border-black/[0.06] px-4 py-3 text-left hover:bg-black/[0.025] last:border-0"><CalendarDays className="h-4 w-4 text-slate-400"/><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-slate-700">{item.title}</span><span className="mt-0.5 block text-[10px] text-slate-400">{item.startAt?new Date(item.startAt).toLocaleString():"—"} · {zh?`${item.utteranceCount} 段发言`:`${item.utteranceCount} statements`}</span></span><ChevronRight className="h-4 w-4 text-slate-300"/></button>)}{!detail.meetings.length&&<div className="py-16 text-center text-[12px] text-slate-400">{zh?"还没有已绑定的会议":"No linked meetings"}</div>}</section>}
      {tab==="utterances"&&<div className="space-y-3">{groupedUtterances.map(([meetingId,items])=><section key={meetingId} className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-sm"><button onClick={()=>void openMeetingWorkspace(meetingId,url=>{window.location.href=url},{title:items[0]?.meetingTitle})} className="flex w-full items-center border-b border-black/[0.06] bg-[#fafafa] px-4 py-2 text-left"><span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-700">{items[0]?.meetingTitle}</span><span className="rounded-full bg-violet-50 px-2 py-0.5 text-[9px] text-violet-600">{sourceLabel(items[0]?.sourceKind)}</span><ChevronRight className="ml-2 h-3.5 w-3.5 text-slate-300"/></button>{items.map(item=><div key={item.transcriptId} className="flex gap-3 border-b border-black/[0.05] px-4 py-2.5 last:border-0"><span className="w-14 shrink-0 pt-0.5 font-mono text-[10px] text-slate-400">{clock(item.startMs)}</span><p className="text-[12px] leading-5 text-slate-600">{item.text}</p></div>)}</section>)}{!groupedUtterances.length&&<div className="py-16 text-center text-[12px] text-slate-400">{zh?"没有可显示的发言":"No statements"}</div>}</div>}
    </div><PersonProfileGenerationDialog open={profileOpen} onOpenChange={setProfileOpen} personId={personId} personName={detail.person.name} statementCount={detail.utterances.length} onStarted={()=>{setProfileJob({status:"processing",progress:{percentage:5,message:zh?"正在准备人物画像…":"Preparing profile…"}});setProfilePollKey(value=>value+1);}}/>
  </div>;
}
