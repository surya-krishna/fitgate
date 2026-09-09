/** Open a URL in the default browser. Best effort; never throws. */
import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      cmd = "cmd";
      // `start` treats the first quoted arg as a window title, hence the empty "".
      args = ["/c", "start", "", url.replace(/&/g, "^&")];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      /* swallow */
    });
    child.unref();
  } catch {
    /* swallow */
  }
}
