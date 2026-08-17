export const LIVE_CAPTIONS_STORAGE_KEY = "calmee.live-captions.enabled";

export function liveCaptionsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(LIVE_CAPTIONS_STORAGE_KEY) !== "false";
}
