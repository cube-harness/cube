import { spawn } from "node:child_process";

export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    const base64 = Buffer.from(text, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
  } catch {
    // Continue with the platform clipboard fallback.
  }

  return new Promise<boolean>((resolve) => {
    let processHandle;
    if (process.platform === "win32") {
      processHandle = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ]);
    } else if (process.platform === "darwin") {
      processHandle = spawn("pbcopy");
    } else {
      processHandle = spawn("xclip", ["-selection", "clipboard"]);
    }

    processHandle.on("error", () => {
      if (process.platform === "win32") {
        const fallback = spawn("clip");
        fallback.on("error", () => resolve(false));
        fallback.stdin.end(text);
        fallback.on("close", (code) => resolve(code === 0));
        return;
      }
      if (process.platform !== "darwin") {
        const fallback = spawn("wl-copy");
        fallback.on("error", () => resolve(false));
        fallback.stdin.end(text);
        fallback.on("close", (code) => resolve(code === 0));
        return;
      }
      resolve(false);
    });

    processHandle.stdin.write(text, "utf-8");
    processHandle.stdin.end();
    processHandle.on("close", (code) => resolve(code === 0));
  });
};
