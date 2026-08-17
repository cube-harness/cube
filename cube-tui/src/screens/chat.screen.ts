import { Container, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { Banner } from "../components/banner.js";
import { InfoBox } from "../components/info-box.js";
import { MessageList } from "../components/message-list.js";
import { Footer } from "../components/footer.js";
import { PromptEditor } from "../components/prompt-editor.js";
import { WorkingIndicator } from "../components/working-indicator.js";
import type { SlashCommandSuggestion, TuiAction } from "../index.js";

export interface MountChatScreenOptions {
  onAction: (action: TuiAction) => void;
  slashCommands: SlashCommandSuggestion[];
  basePath: string;
}

export const mountChatScreen = (
  tui: TUI,
  options: MountChatScreenOptions,
) => {
  const banner = new Banner();
  const infoBox = new InfoBox();
  const messageList = new MessageList();
  const footer = new Footer();
  const promptEditor = new PromptEditor({ tui, ...options });
  const workingIndicator = new WorkingIndicator(tui);
  const inlineControlHost = new Container();

  tui.addChild(banner);
  tui.addChild(infoBox);
  tui.addChild(messageList);
  tui.addChild(workingIndicator);
  tui.addChild(promptEditor);
  tui.addChild(inlineControlHost);
  tui.addChild(footer);
  tui.setFocus(promptEditor);

  tui.addInputListener((data: string) => {
    if (matchesKey(data, Key.pageUp)) {
      messageList.pageUp(10);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.pageDown)) {
      messageList.pageDown(10);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  return {
    banner,
    infoBox,
    messageList,
    workingIndicator,
    promptEditor,
    inlineControlHost,
    footer,
  };
};
