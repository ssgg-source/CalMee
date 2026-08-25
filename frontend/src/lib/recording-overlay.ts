import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { primaryMonitor } from "@tauri-apps/api/window";

const LABEL = "recording-overlay";

export async function showRecordingOverlay() {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    await existing.show();
    return existing;
  }

  const monitor = await primaryMonitor();
  const scale = monitor?.scaleFactor || 1;
  const screenWidth = monitor ? monitor.size.width / scale : 1440;
  const screenX = monitor ? monitor.position.x / scale : 0;
  const width = 420;
  return await new Promise<WebviewWindow>((resolve, reject) => {
    const overlay = new WebviewWindow(LABEL, {
      url: "/recording-overlay",
      title: "CalMee Recording",
      width,
      height: 64,
      x: Math.round(screenX + (screenWidth - width) / 2),
      y: 42,
      resizable: true,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
      focus: false,
    });
    overlay.once("tauri://created", async () => {
      try {
        await overlay.show();
        resolve(overlay);
      } catch (error) {
        reject(error);
      }
    });
    overlay.once("tauri://error", event => {
      reject(new Error(String(event.payload || "Could not create recording overlay")));
    });
  });
}

export async function hideRecordingOverlay() {
  const overlay = await WebviewWindow.getByLabel(LABEL);
  if (overlay) await overlay.hide();
}
