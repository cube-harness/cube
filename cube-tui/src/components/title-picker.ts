import { FieldPicker, type FieldPickerItem } from "./field-picker.js";
import { appTheme } from "../themes/app.theme.js";

export type TitlePickerItem = FieldPickerItem;

export interface TerminalTitleValues {
  model?: string;
  workspace?: string;
  threadTitle?: string;
  threadId?: string;
  status?: string;
}

export const DEFAULT_TITLE_SEPARATOR = " | ";

export function formatTerminalTitle(
  fields: string[],
  values: TerminalTitleValues,
  separator: string = DEFAULT_TITLE_SEPARATOR,
): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field === "model" && values.model) parts.push(values.model);
    else if (field === "workspace" && values.workspace) parts.push(values.workspace);
    else if (field === "threadTitle" && values.threadTitle) parts.push(values.threadTitle);
    else if (field === "threadId" && values.threadId) parts.push(values.threadId);
    else if (field === "status" && values.status) parts.push(values.status);
  }
  return parts.length > 0 ? parts.join(separator) : values.model || values.workspace || "Cube";
}

export interface TitlePickerOptions {
  items?: TitlePickerItem[];
  initialSelection?: string[];
  currentValues?: TerminalTitleValues;
  onSelect: (selectedIds: string[]) => void;
  onCancel: () => void;
}

export class TitlePickerComponent extends FieldPicker {
  constructor(options: TitlePickerOptions) {
    const current = options.currentValues ?? {};
    const initial = options.initialSelection ?? ["model", "workspace", "threadTitle"];

    const items = options.items ?? [
      {
        id: "model",
        label: "Active Model",
        description: current.model || "cube-agent",
        selected: initial.includes("model"),
      },
      {
        id: "workspace",
        label: "Workspace Directory",
        description: current.workspace || process.cwd(),
        selected: initial.includes("workspace"),
      },
      {
        id: "threadTitle",
        label: "Thread Title",
        description: current.threadTitle || "Untitled Thread",
        selected: initial.includes("threadTitle"),
      },
      {
        id: "threadId",
        label: "Thread ID",
        description: current.threadId || "new thread",
        selected: initial.includes("threadId"),
      },
      {
        id: "status",
        label: "Agent Status",
        description: current.status || "Idle",
        selected: initial.includes("status"),
      },
    ];

    const initialSelection = options.items
      ? options.items.filter((i) => i.selected).map((i) => i.id)
      : [...initial];

    super({
      title: "Configure Terminal Title",
      items,
      initialSelection,
      preview: (ids) => appTheme.ui.primary(formatTerminalTitle(ids, current)),
      onSelect: options.onSelect,
      onCancel: options.onCancel,
    });
  }
}
