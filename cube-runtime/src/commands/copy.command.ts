import { spawn } from "node:child_process";
import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export const extractLastAssistantResponse = (messages: unknown[]): string | null => {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: unknown;
      content?: unknown;
    };

    if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }

      if (
        msg.content &&
        typeof msg.content === "object" &&
        Array.isArray((msg.content as { parts?: unknown[] }).parts)
      ) {
        const parts = (msg.content as { parts: unknown[] }).parts;
        const textParts = parts
          .filter(
            (p): p is { type: "text"; text: string } =>
              typeof p === "object" &&
              p !== null &&
              (p as { type?: unknown }).type === "text" &&
              typeof (p as { text?: unknown }).text === "string" &&
              Boolean((p as { text: string }).text.trim()),
          )
          .map((p) => p.text.trim());

        if (textParts.length > 0) {
          return textParts.join("\n\n");
        }
      }
    }
  }

  return null;
};

export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    const base64 = Buffer.from(text, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
  } catch {
    // Ignore terminal OSC sequence errors
  }

  return new Promise<boolean>((resolve) => {
    let proc;
    if (process.platform === "win32") {
      proc = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ]);
    } else if (process.platform === "darwin") {
      proc = spawn("pbcopy");
    } else {
      proc = spawn("xclip", ["-selection", "clipboard"]);
    }

    proc.on("error", () => {
      if (process.platform === "win32") {
        const fallback = spawn("clip");
        fallback.on("error", () => resolve(true));
        fallback.stdin.end(text);
        fallback.on("close", (code) => resolve(code === 0));
        return;
      }
      if (process.platform !== "darwin") {
        const fallback = spawn("wl-copy");
        fallback.on("error", () => resolve(true));
        fallback.stdin.end(text);
        fallback.on("close", (code) => resolve(code === 0));
        return;
      }
      resolve(true);
    });

    proc.stdin.write(text, "utf-8");
    proc.stdin.end();

    proc.on("close", (code) => {
      resolve(code === 0);
    });
  });
};

export interface CopyCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
  copyFn?: (text: string) => Promise<boolean>;
}

export const createCopyCommand =
  (deps: CopyCommandDependencies): CommandHandler =>
  async () => {
    const threadId = deps.session.thread.getId();
    if (!threadId) {
      deps.dispatcher.emit({
        type: "system:message",
        content: "No active thread or response to copy.",
      });
      return;
    }

    try {
      const messages = await deps.session.thread.listMessages({ threadId });
      const lastResponse = extractLastAssistantResponse(messages);

      if (!lastResponse) {
        deps.dispatcher.emit({
          type: "system:message",
          content: "No assistant response found to copy.",
        });
        return;
      }

      const copy = deps.copyFn ?? copyToClipboard;
      await copy(lastResponse);

      deps.dispatcher.emit({
        type: "system:message",
        content: "Copied last response to clipboard as markdown.",
      });
    } catch (error: unknown) {
      deps.dispatcher.emit({
        type: "system:error",
        error: `Failed to copy response: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
