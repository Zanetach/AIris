import { Modal, App, Notice } from "obsidian";
import { isZhLocale, t } from "../../lang/helpers";
import type { PromptPreset } from "../settings/settings";

export const bi = (zh: string, en: string): string =>
  isZhLocale() ? zh : en;

export interface NoteImageOption {
  path: string;
  fileName: string;
  previewSrc: string;
}

export interface PresetEditorResult {
  selectedId: string;
  name: string;
  prompt: string;
}

export class ReferenceImagePreviewModal extends Modal {
  private readonly imageUrl: string;
  private readonly fileName: string;
  private readonly actions?: {
    downloadText: string;
    insertText: string;
    onDownload: () => void;
    onInsert: () => void;
  };

  constructor(
    app: App,
    imageUrl: string,
    fileName: string,
    actions?: {
      downloadText: string;
      insertText: string;
      onDownload: () => void;
      onInsert: () => void;
    },
  ) {
    super(app);
    this.imageUrl = imageUrl;
    this.fileName = fileName;
    this.actions = actions;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sidebar-reference-preview-modal");
    contentEl.createEl("h3", {
      text: this.fileName || bi("参考图预览", "Reference Preview"),
    });
    contentEl.createEl("img", {
      cls: "sidebar-reference-preview-modal-image",
      attr: {
        src: this.imageUrl,
        alt: this.fileName || bi("参考图预览", "Reference Preview"),
      },
    });

    if (this.actions) {
      const actionsEl = contentEl.createDiv("sidebar-reference-preview-actions");
      actionsEl
        .createEl("button", {
          text: this.actions.downloadText,
        })
        .addEventListener("click", () => {
          this.actions?.onDownload();
        });
      actionsEl
        .createEl("button", {
          text: this.actions.insertText,
          cls: "mod-cta",
        })
        .addEventListener("click", () => {
          this.actions?.onInsert();
          this.close();
        });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class NoteImagePickerModal extends Modal {
  private readonly options: NoteImageOption[];
  private readonly preselectedPaths: Set<string>;
  private readonly onConfirm: (paths: string[]) => void;

  constructor(
    app: App,
    options: NoteImageOption[],
    preselectedPaths: Set<string>,
    onConfirm: (paths: string[]) => void,
  ) {
    super(app);
    this.options = options;
    this.preselectedPaths = preselectedPaths;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sidebar-note-image-picker-modal");
    contentEl.createEl("h3", {
      text: bi(
        "从当前笔记选择参考图",
        "Select Reference Images from Current Note",
      ),
    });

    if (this.options.length === 0) {
      contentEl.createDiv({
        cls: "sidebar-note-image-picker-empty",
        text: bi(
          "当前笔记未找到可用图片",
          "No available images found in current note",
        ),
      });
      return;
    }

    const selected = new Set<string>(this.preselectedPaths);
    const list = contentEl.createDiv("sidebar-note-image-picker-list");

    this.options.forEach((option) => {
      const item = list.createDiv("sidebar-note-image-picker-item");
      const label = item.createEl("label", {
        cls: "sidebar-note-image-picker-label",
      });
      const checkbox = label.createEl("input", {
        attr: { type: "checkbox" },
      });
      checkbox.checked = selected.has(option.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(option.path);
        else selected.delete(option.path);
      });
      label.createEl("img", {
        cls: "sidebar-note-image-picker-thumb",
        attr: { src: option.previewSrc, alt: option.fileName },
      });
      label.createDiv({
        cls: "sidebar-note-image-picker-name",
        text: option.fileName,
      });
    });

    const actions = contentEl.createDiv("modal-button-container");
    actions
      .createEl("button", { text: t("Cancel") })
      .addEventListener("click", () => {
        this.close();
      });
    actions
      .createEl("button", { text: bi("确认", "Confirm"), cls: "mod-cta" })
      .addEventListener("click", () => {
        this.onConfirm(Array.from(selected));
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PresetBrowserModal extends Modal {
  private readonly presets: PromptPreset[];
  private readonly onSelect: (preset: PromptPreset) => void;

  constructor(
    app: App,
    presets: PromptPreset[],
    onSelect: (preset: PromptPreset) => void,
  ) {
    super(app);
    this.presets = presets;
    this.onSelect = onSelect;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: bi("全部预设", "All Presets") });

    if (this.presets.length === 0) {
      contentEl.createDiv({
        cls: "sidebar-recent-presets-empty",
        text: bi("暂无预设", "No presets yet"),
      });
      return;
    }

    const list = contentEl.createDiv("sidebar-all-presets-list");
    [...this.presets].reverse().forEach((preset) => {
      const btn = list.createEl("button", {
        cls: "sidebar-all-preset-item",
        text: preset.name,
      });
      btn.addEventListener("click", () => {
        this.onSelect(preset);
        this.close();
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PresetEditorModal extends Modal {
  private readonly presets: PromptPreset[];
  private selectedId: string;
  private nameValue: string = "";
  private promptValue: string = "";
  private readonly onSave: (result: PresetEditorResult) => void;

  constructor(
    app: App,
    presets: PromptPreset[],
    initialPresetId: string,
    onSave: (result: PresetEditorResult) => void,
  ) {
    super(app);
    this.presets = presets;
    this.selectedId = initialPresetId;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", {
      text: bi("添加 / 选择预设", "Add / Select Preset"),
    });

    const presetRow = contentEl.createDiv("canvas-ai-modal-row");
    presetRow.createEl("label", { text: bi("已有预设", "Existing Presets") });

    const presetSelect = presetRow.createEl("select");
    presetSelect.createEl("option", {
      value: "",
      text: bi("新建预设", "Create New Preset"),
    });
    this.presets.forEach((p) => {
      presetSelect.createEl("option", { value: p.id, text: p.name });
    });
    if (this.selectedId) {
      presetSelect.value = this.selectedId;
    }

    const nameRow = contentEl.createDiv("canvas-ai-modal-row");
    nameRow.createEl("label", { text: bi("预设名称", "Preset Name") });
    const nameInput = nameRow.createEl("input", {
      attr: {
        type: "text",
        placeholder: bi("输入预设名称", "Enter preset name"),
      },
    });

    const promptRow = contentEl.createDiv("canvas-ai-modal-row");
    promptRow.createEl("label", { text: bi("预设 Prompt", "Preset Prompt") });
    const promptInput = promptRow.createEl("textarea", {
      attr: {
        rows: "6",
        placeholder: bi("输入预设 Prompt 内容", "Enter preset prompt content"),
      },
    });
    promptInput.addClass("canvas-ai-modal-prompt-input");

    const autoResizePromptInput = (): void => {
      promptInput.style.height = "auto";
      const maxHeight = 360;
      const nextHeight = Math.min(promptInput.scrollHeight, maxHeight);
      promptInput.style.height = `${nextHeight}px`;
      promptInput.style.overflowY =
        promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
    };

    const applySelectedPreset = (id: string): void => {
      if (!id) {
        nameInput.value = "";
        promptInput.value = "";
        this.nameValue = "";
        this.promptValue = "";
        autoResizePromptInput();
        return;
      }

      const preset = this.presets.find((p) => p.id === id);
      if (!preset) return;

      nameInput.value = preset.name;
      promptInput.value = preset.prompt;
      this.nameValue = preset.name;
      this.promptValue = preset.prompt;
      autoResizePromptInput();
    };

    applySelectedPreset(this.selectedId);

    presetSelect.addEventListener("change", () => {
      this.selectedId = presetSelect.value;
      applySelectedPreset(this.selectedId);
    });

    nameInput.addEventListener("input", () => {
      this.nameValue = nameInput.value;
    });

    promptInput.addEventListener("input", () => {
      this.promptValue = promptInput.value;
      autoResizePromptInput();
    });

    const actions = contentEl.createDiv("modal-button-container");
    const cancelBtn = actions.createEl("button", { text: t("Cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", {
      text: bi("保存", "Save"),
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      const name = this.nameValue.trim();
      const prompt = this.promptValue.trim();

      if (!name) {
        new Notice(bi("请输入预设名称", "Please enter preset name"));
        return;
      }
      if (!prompt) {
        new Notice(
          bi("请输入预设 Prompt 内容", "Please enter preset prompt content"),
        );
        return;
      }

      this.close();
      this.onSave({
        selectedId: this.selectedId,
        name,
        prompt,
      });
    });

    setTimeout(() => nameInput.focus(), 50);
    setTimeout(autoResizePromptInput, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
