"use client";

import { useEffect, useState } from "react";
import { invoke } from "@/lib/data-invoke";
import { CalendarDays, CheckCircle2, Cloud, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/layout/ProductPage";
import { ProductButton, ProductInput } from "@/components/ui/ProductControls";
import { useLanguage } from "@/contexts/LanguageContext";
import { reportTechnicalError, toUserFacingError } from "@/lib/feedback";

type Settings = {
  localEnabled: boolean;
  caldavEnabled: boolean;
  caldavUrl?: string;
  caldavUsername?: string;
  caldavPassword?: string;
  caldavCalendarPath?: string;
  syncMode: string;
  lastSyncAt?: string;
};

const defaults: Settings = { localEnabled: false, caldavEnabled: false, syncMode: "two_way" };

export function CalendarSettings() {
  const { t, dateLocale, locale } = useLanguage();
  const [value, setValue] = useState<Settings>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const showError = (title: string, error: unknown) => {
    reportTechnicalError("calendar-settings", error);
    toast.error(title, { description: toUserFacingError(error, locale).message });
  };

  useEffect(() => {
    invoke<Settings>("api_get_calendar_settings")
      .then(setValue)
      .catch((error) => showError(t("calendarSettings.loadFailed"), error))
      .finally(() => setLoading(false));
  }, [t]);

  const save = async () => {
    setSaving(true);
    try {
      await invoke("api_save_calendar_settings", { settings: value });
      toast.success(t("calendarSettings.saved"));
    } catch (error) {
      showError(t("calendar.saveFailed"), error);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    await save();
    setTesting(true);
    try {
      await invoke<string>("api_test_caldav");
      toast.success(t("calendarSettings.connected"), { description: t("calendarSettings.connectionValidated") });
    } catch (error) {
      showError(t("calendarSettings.connectionFailed"), error);
    } finally {
      setTesting(false);
    }
  };

  const sync = async () => {
    await save();
    setSyncing(true);
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 2, 1);
      const result = await invoke<any>("api_sync_calendars", { startAt: start.toISOString(), endAt: end.toISOString() });
      toast.success(t("calendarSettings.syncResult", { local: result.local, caldav: result.caldav }));
      if (result.warnings?.length) {
        reportTechnicalError("calendar-sync-warnings", result.warnings);
        toast.warning(t("calendar.partialSync"), { description: toUserFacingError(result.warnings.join("; "), locale).message });
      }
    } catch (error) {
      showError(t("calendar.syncFailed"), error);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div className="h-36 animate-pulse rounded-xl bg-muted" />;

  return (
    <div className="space-y-5">
      <SettingsSection>
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><CalendarDays className="h-4 w-4" /></span>
            <div><h2 className="text-[15px] font-semibold">{t("calendarSettings.localTitle")}</h2><p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t("calendarSettings.localDescription")}</p></div>
          </div>
          <Switch checked={value.localEnabled} onCheckedChange={(localEnabled) => setValue({ ...value, localEnabled })} />
        </div>
      </SettingsSection>

      <SettingsSection>
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary"><Cloud className="h-4 w-4" /></span>
            <div><h2 className="text-[15px] font-semibold">{t("calendarSettings.serverTitle")}</h2><p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t("calendarSettings.serverDescription")}</p></div>
          </div>
          <Switch checked={value.caldavEnabled} onCheckedChange={(caldavEnabled) => setValue({ ...value, caldavEnabled, syncMode: caldavEnabled ? "two_way" : value.syncMode })} />
        </div>
        {value.caldavEnabled && (
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/70 pt-5">
            <ProductInput className="col-span-2" placeholder={t("calendarSettings.url")} value={value.caldavUrl || ""} onChange={(event) => setValue({ ...value, caldavUrl: event.target.value })} />
            <ProductInput placeholder={t("calendarSettings.username")} value={value.caldavUsername || ""} onChange={(event) => setValue({ ...value, caldavUsername: event.target.value })} />
            <ProductInput type="password" placeholder={t("calendarSettings.password")} value={value.caldavPassword || ""} onChange={(event) => setValue({ ...value, caldavPassword: event.target.value })} />
            <ProductInput className="col-span-2" placeholder={t("calendarSettings.path")} value={value.caldavCalendarPath || ""} onChange={(event) => setValue({ ...value, caldavCalendarPath: event.target.value })} />
            <ProductButton className="col-span-2" onClick={() => void test()} disabled={testing}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {t("calendarSettings.connect")}
            </ProductButton>
          </div>
        )}
      </SettingsSection>

      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] text-muted-foreground">
          {value.lastSyncAt ? t("calendarSettings.lastSync", { time: new Date(value.lastSyncAt).toLocaleString(dateLocale) }) : t("calendarSettings.never")}
        </span>
        <div className="flex gap-2">
          <ProductButton size="sm" onClick={() => void save()} disabled={saving}><Save className="h-4 w-4" />{t("calendar.save")}</ProductButton>
          <ProductButton size="sm" variant="primary" onClick={() => void sync()} disabled={syncing}>{syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{t("calendarSettings.syncNow")}</ProductButton>
        </div>
      </div>
    </div>
  );
}
