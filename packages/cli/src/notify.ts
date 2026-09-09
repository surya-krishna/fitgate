/**
 * Best-effort OS notification. Never throws, never blocks: spawns a detached
 * helper and forgets about it.
 */
import { spawn } from "node:child_process";

function fire(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      /* swallow */
    });
    child.unref();
  } catch {
    /* swallow */
  }
}

function esc(s: string): string {
  return s.replace(/["\\]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

export function notify(title: string, body: string, url?: string): void {
  const t = title.slice(0, 80);
  const b = body.slice(0, 200);
  switch (process.platform) {
    case "darwin":
      fire("osascript", ["-e", `display notification "${esc(b)}" with title "${esc(t)}"`]);
      break;
    case "win32": {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        "$n.Visible = $true",
        `$n.ShowBalloonTip(10000, "${t.replace(/"/g, "'")}", "${b.replace(/"/g, "'")}", [System.Windows.Forms.ToolTipIcon]::Info)`,
        "Start-Sleep -Seconds 6",
        "$n.Dispose()",
      ].join("; ");
      fire("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]);
      break;
    }
    default: {
      const args = ["-a", "FitGate", "-u", "normal", "-t", "20000", t, url ? `${b}\n${url}` : b];
      fire("notify-send", args);
    }
  }
}
