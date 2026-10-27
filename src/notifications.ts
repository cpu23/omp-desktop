import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
} from "@tauri-apps/plugin-notification";

const ENABLED_KEY = "omp-desktop.completion-notifications.v1";

type OpenRuntime = (runtimeId: string) => void;
type NoticeKind = "ok" | "warn" | "idle";

function browserNotificationsAvailable(): boolean {
  return typeof Notification !== "undefined";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Native Tauri notifications, with the Web Notifications API for browser use. */
export class CompletionNotifications {
  #button: HTMLButtonElement;
  #status: HTMLElement;
  #openRuntime: OpenRuntime;
  #native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  #enabled: boolean;
  #nativeActionListener: Promise<void> | null = null;

  constructor(button: HTMLButtonElement, status: HTMLElement, openRuntime: OpenRuntime) {
    this.#button = button;
    this.#status = status;
    this.#openRuntime = openRuntime;
    try {
      this.#enabled = localStorage.getItem(ENABLED_KEY) === "true";
    } catch {
      this.#enabled = false;
    }
  }

  async initialize(): Promise<void> {
    this.#button.addEventListener("click", () => void this.#toggle());
    if (!this.#native && !browserNotificationsAvailable()) {
      this.#button.disabled = true;
      this.#setStatus("Notifications are not supported in this runtime.", "warn");
      this.#renderButton();
      return;
    }
    this.#renderButton();
    if (!this.#enabled) {
      this.#setStatus("Completion notifications are off.", "idle");
      return;
    }
    try {
      if (!(await this.#permissionGranted())) {
        this.#setStatus("Enabled, but system permission is not granted. Turn Off, then On to retry.", "warn");
        return;
      }
      if (this.#native) {
        try {
          await this.#ensureNativeActionListener();
        } catch (error) {
          this.#setStatus(`Enabled; notification clicks cannot focus a session (${errorText(error)}).`, "warn");
          return;
        }
      }
      this.#setStatus("Completion notifications are on.", "ok");
    } catch (error) {
      this.#setStatus(`Could not check notification permission: ${errorText(error)}`, "warn");
    }
  }

  async notifyCompletion(runtimeId: string, title: string): Promise<void> {
    if (!this.#enabled) return;
    try {
      if (!(await this.#permissionGranted())) {
        this.#setStatus("Notification permission is no longer granted; check browser or system settings.", "warn");
        return;
      }
      let clickWarning: string | null = null;
      if (this.#native) {
        try {
          await this.#ensureNativeActionListener();
        } catch (error) {
          clickWarning = `click-to-focus unavailable (${errorText(error)})`;
        }
        // The plugin's sendNotification wrapper returns void. Await the native
        // command so permission/IPC failures reach the Settings status instead.
        await invoke("plugin:notification|notify", {
          options: { title, body: "A response finished.", icon: "sh.omp.desktop", extra: { runtimeId } },
        });
      } else {
        const notification = new Notification(title, { body: "A response finished." });
        notification.onclick = () => {
          notification.close();
          window.focus();
          this.#openRuntime(runtimeId);
        };
        notification.onerror = () => {
          this.#setStatus("The browser could not deliver a completion notification.", "warn");
        };
      }
      this.#setStatus(
        clickWarning ? `Completion notification sent; ${clickWarning}.` : "Completion notification sent.",
        clickWarning ? "warn" : "ok",
      );
    } catch (error) {
      this.#setStatus(`Could not deliver completion notification: ${errorText(error)}`, "warn");
    }
  }

  async #toggle(): Promise<void> {
    if (this.#enabled) {
      this.#enabled = false;
      const stored = this.#storePreference();
      this.#renderButton();
      this.#setStatus(
        stored ? "Completion notifications are off." : "Off for this window; the preference could not be saved.",
        stored ? "idle" : "warn",
      );
      return;
    }
    try {
      if (!this.#native && !browserNotificationsAvailable()) {
        this.#setStatus("Notifications are not supported in this runtime.", "warn");
        return;
      }
      const permission = await this.#requestPermissionFromClick();
      if (permission !== "granted") {
        const platform = this.#native ? "operating system" : "browser";
        this.#setStatus(
          permission === "denied"
            ? `Permission was denied by the ${platform}; allow notifications in its settings.`
            : `The ${platform} did not grant notification permission; retry from this control or check its settings.`,
          "warn",
        );
        return;
      }
      this.#enabled = true;
      const stored = this.#storePreference();
      this.#renderButton();
      if (this.#native) {
        try {
          await this.#ensureNativeActionListener();
        } catch (error) {
          this.#setStatus(
            `Notifications are on; click-to-focus could not be enabled (${errorText(error)}).`,
            "warn",
          );
          return;
        }
      }
      this.#setStatus(
        stored ? "Completion notifications are on." : "On for this window; the preference could not be saved.",
        stored ? "ok" : "warn",
      );
    } catch (error) {
      this.#setStatus(`Could not enable completion notifications: ${errorText(error)}`, "warn");
    }
  }

  async #permissionGranted(): Promise<boolean> {
    if (this.#native) return await isPermissionGranted();
    return browserNotificationsAvailable() && Notification.permission === "granted";
  }

  async #requestPermissionFromClick(): Promise<NotificationPermission> {
    if (this.#native) {
      if (await isPermissionGranted()) return "granted";
      return await requestPermission();
    }
    if (!browserNotificationsAvailable()) return "denied";
    if (Notification.permission === "granted" || Notification.permission === "denied") return Notification.permission;
    return await Notification.requestPermission();
  }

  #ensureNativeActionListener(): Promise<void> {
    if (!this.#nativeActionListener) {
      this.#nativeActionListener = onAction((event) => {
        if (event.actionId !== "tap") return;
        const runtimeId = event.notification?.extra?.runtimeId;
        if (typeof runtimeId !== "string") return;
        window.focus();
        this.#openRuntime(runtimeId);
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#nativeActionListener = null;
          throw error;
        });
    }
    return this.#nativeActionListener;
  }

  #storePreference(): boolean {
    try {
      localStorage.setItem(ENABLED_KEY, String(this.#enabled));
      return true;
    } catch {
      return false;
    }
  }

  #renderButton(): void {
    this.#button.textContent = this.#enabled ? "On" : "Off";
    this.#button.setAttribute("aria-pressed", String(this.#enabled));
    this.#button.setAttribute("aria-label", `Completion notifications ${this.#enabled ? "on" : "off"}`);
  }

  #setStatus(text: string, kind: NoticeKind): void {
    this.#status.textContent = text;
    this.#status.dataset.kind = kind;
  }
}
