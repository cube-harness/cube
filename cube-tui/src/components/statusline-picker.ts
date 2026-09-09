import { FieldPicker, type FieldPickerItem } from "./field-picker.js";
import { appTheme } from "../themes/app.theme.js";

export type StatusLinePickerItem = FieldPickerItem;

export interface StatusLinePickerOptions {
  items?: StatusLinePickerItem[];
  initialSelection?: string[];
  currentValues?: {
    model?: string;
    workspace?: string;
    agentMd?: string;
    threadTitle?: string;
    threadId?: string;
    status?: string;
  };
  onSelect: (selectedIds: string[]) => void;
  onCancel: () => void;
}

export class StatusLinePickerComponent extends FieldPicker {
  constructor(options: StatusLinePickerOptions) {
    const current = options.currentValues ?? {};
    const initial = options.initialSelection ?? [
      "model",
      "workspace",
      "agentMd",
      "threadTitle",
    ];

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
        id: "agentMd",
        label: "AGENT.md Status",
        description: current.agentMd || "AGENT.md (active)",
        selected: initial.includes("agentMd"),
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
      title: "Configure Footer Status Line",
      items,
      initialSelection,
      preview: ids => ids.length
        ? ids.map(id => appTheme.ui.primary(items.find(item => item.id === id)?.description || id))
            .join(appTheme.ui.muted(" • "))
        : "(none)",
      onSelect: options.onSelect,
      onCancel: options.onCancel,
    });
  }
}
