import { type TUI } from "@earendil-works/pi-tui";
import { Banner } from "../components/banner.js";
import { InfoBox } from "../components/info-box.js";
import { MessageList } from "../components/message-list.js";
import { Footer } from "../components/footer.js";
import { PromptEditor } from "../components/prompt-editor.js";
import { WorkingIndicator } from "../components/working-indicator.js";
import type { SlashCommandSuggestion, CubeUIAction } from "../index.js";

export interface MountChatScreenOptions {
  onAction: (action: CubeUIAction) => void;
  slashCommands: SlashCommandSuggestion[];
  basePath: string;
  initialHistory?: string[];
  statusLine?: string[];
}

export const mountChatScreen = (
  tui: TUI,
  options: MountChatScreenOptions,
) => {
  const banner = new Banner();
  const infoBox = new InfoBox();
  const messageList = new MessageList();
  const footer = new Footer(undefined, options.statusLine);
  const promptEditor = new PromptEditor({ tui, ...options });
  const workingIndicator = new WorkingIndicator(tui);

  tui.addChild(banner);
  tui.addChild(infoBox);
  tui.addChild(messageList);
  tui.addChild(workingIndicator);
  tui.addChild(promptEditor);
  tui.addChild(footer);
  tui.setFocus(promptEditor);

  return {
    banner,
    infoBox,
    messageList,
    workingIndicator,
    promptEditor,
    footer,
  };
};
