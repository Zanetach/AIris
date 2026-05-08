import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  setIcon,
  TFile,
  Menu,
  Editor,
  MarkdownView,
} from "obsidian";
import type CanvasAIPlugin from "../../main";
import type { PromptPreset, QuickSwitchModel } from "../settings/settings";
import { isZhLocale, t } from "../../lang/helpers";
import type { NotesSelectionContext } from "./notes-selection-handler";
import {
  bi,
  ReferenceImagePreviewModal,
  NoteImagePickerModal,
  PresetBrowserModal,
  PresetEditorModal,
} from "./sidebar-modals";
import type { NoteImageOption, PresetEditorResult } from "./sidebar-modals";
import {
  SidebarCandidateManager,
} from "./sidebar-candidate-manager";
import type { SidebarInputImage, SidebarImageCandidate } from "./sidebar-candidate-manager";
import {
  SidebarGenerationQueue,
} from "./sidebar-generation-queue";
import type { GenerationQueueTask } from "./sidebar-generation-queue";

export const VIEW_TYPE_SIDEBAR_COPILOT = "canvas-ai-sidebar-copilot";

interface CurrentNoteInjectionResult {
  prompt: string;
  replaced: boolean;
}

type PrimaryReferenceSource = "uploaded" | "note";

export class SideBarCoPilotView extends ItemView {
  private readonly referencePromptPrefix = "[参考图] ";
  private readonly pptAutoMarker = "[PPT_AUTO]";
  private readonly pptAutoLegacyMarker = "[PPT_AUTO_8]";
  private readonly currentNotePlaceholderTokens = [
    "@current_note",
    "{{current_note}}",
    "@当前笔记",
  ];
  private readonly currentNoteShortcutPattern =
    /(^|[\s,，。；;])@(?=$|[\s,，。；;])/g;
  private readonly currentNoteTokenPattern = /@current_note(?:\([^)]+\))?/g;

  private plugin: CanvasAIPlugin;

  private messagesContainer: HTMLElement;
  private candidateContainer: HTMLElement;
  private candidateListEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private optimizePromptBtn: HTMLButtonElement;
  private generateBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private retryFailedBtn: HTMLButtonElement;
  private insertAllBtn: HTMLButtonElement;
  private generationStatusEl: HTMLElement;
  private imageToImageToggleBtn: HTMLButtonElement;
  private imageToImageStateEl: HTMLElement;
  private imageToImagePanelEl: HTMLElement;
  private imageToImageUploadBtn: HTMLButtonElement;
  private imageToImageClearBtn: HTMLButtonElement;
  private imageToImageFileInput: HTMLInputElement;
  private imageToImagePreviewWrapEl: HTMLElement;
  private imageToImagePreviewEl: HTMLImageElement;
  private imageToImageFileNameEl: HTMLElement;

  private imageModelSelect: HTMLSelectElement;
  private resolutionSelect: HTMLSelectElement;
  private aspectRatioSelect: HTMLSelectElement;
  private imageCountSelect: HTMLSelectElement;

  private presetSelect: HTMLSelectElement;
  private presetManageBtn: HTMLButtonElement;
  private presetDeleteBtn: HTMLButtonElement;
  private viewAllPresetsBtn: HTMLButtonElement;
  private recentPresetsListEl: HTMLElement;

  private imagePresets: PromptPreset[] = [];
  private quickSwitchImageModels: QuickSwitchModel[] = [];
  private selectedImageModel: string = "";

  private promptSaveTimer: number | null = null;
  private generationStartTime: number | null = null;
  private elapsedTimer: number | null = null;

  private capturedContext: NotesSelectionContext | null = null;
  private isImageToImageEnabled: boolean = false;
  private uploadedReferenceImage: SidebarInputImage | null = null;
  private selectedReferenceImages: SidebarInputImage[] = [];
  private primaryReferenceSource: PrimaryReferenceSource | null = null;
  private referencePreviewObjectUrl: string | null = null;

  private candidateManager!: SidebarCandidateManager;
  private generationQueue!: SidebarGenerationQueue;

  private tr(zh: string, en: string): string {
    return isZhLocale() ? zh : en;
  }

  constructor(leaf: WorkspaceLeaf, plugin: CanvasAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR_COPILOT;
  }

  getDisplayText(): string {
    return "AIris";
  }

  getIcon(): string {
    return "eye";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("sidebar-copilot-container");

    this.createDOM(container);

    this.candidateManager = new SidebarCandidateManager(
      this.plugin,
      this.candidateListEl,
      this.messagesContainer,
      (zh, en) => this.tr(zh, en),
      {
        updateButtons: () => this.updateGenerateButtonState(),
        getPendingTaskCount: () => this.generationQueue?.pendingTaskCount ?? 0,
        onRegenerateCandidate: (id) => this.handleRegenerateCandidate(id),
      },
    );

    this.generationQueue = new SidebarGenerationQueue(
      this.plugin,
      this.candidateManager,
      (zh, en) => this.tr(zh, en),
      {
        addMessage: (role, content) =>
          this.candidateManager.addMessage(role, content),
        updateButtons: () => this.updateGenerateButtonState(),
      },
    );

    this.setupEvents();
    this.candidateManager.renderCandidateList();
    this.candidateManager.startCandidateCleanupTimer();
    this.initFromSettings();
    this.registerActiveFileListener();
  }

  async onClose(): Promise<void> {
    this.candidateManager?.stopCleanupTimer();
    this.candidateManager?.stopRenderRaf();
    if (this.promptSaveTimer !== null) {
      window.clearTimeout(this.promptSaveTimer);
      this.promptSaveTimer = null;
    }
    if (this.elapsedTimer !== null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.setReferencePreviewObjectUrl(null);
  }

  public refreshFromSettings(): void {
    this.initFromSettings();
  }

  public onSelectionCleared(): void {
    this.capturedContext = null;
    this.updateGenerateButtonState();
  }

  private createDOM(container: HTMLElement): void {
    const header = container.createDiv("sidebar-copilot-header");
    header.createDiv({ cls: "sidebar-copilot-title", text: t("Image") });

    this.candidateContainer = container.createDiv("sidebar-image-candidates");
    const candidateHeader = this.candidateContainer.createDiv(
      "sidebar-image-candidates-header",
    );
    candidateHeader.createDiv({
      cls: "sidebar-image-candidates-title",
      text: this.tr("生成候选图", "Generated Candidates"),
    });

    this.insertAllBtn = candidateHeader.createEl("button", {
      cls: "sidebar-insert-all-btn",
      text: this.tr("一键插入全部", "Insert All"),
    });
    this.insertAllBtn.addEventListener("click", () => {
      void this.candidateManager.handleInsertAllCandidates();
    });

    this.retryFailedBtn = candidateHeader.createEl("button", {
      cls: "sidebar-retry-failed-btn",
      text: this.tr("重试失败项", "Retry Failed"),
    });
    this.retryFailedBtn.addEventListener("click", () => {
      this.generationQueue.retryFailedTasks();
    });

    this.candidateListEl = this.candidateContainer.createDiv(
      "sidebar-image-candidates-list",
    );
    this.registerDomEvent(this.candidateListEl, "scroll", () => {
      this.candidateManager?.scheduleCandidateListRender();
    });
    this.registerDomEvent(window, "resize", () => {
      this.candidateManager?.scheduleCandidateListRender();
    });

    const footer = container.createDiv(
      "canvas-ai-palette-footer sidebar-studio-layout",
    );

    const zone1 = footer.createDiv("sidebar-zone-1");

    const presetSection = zone1.createDiv("sidebar-preset-section");
    presetSection.createDiv({
      cls: "sidebar-section-title",
      text: this.tr("预设管理", "Preset Management"),
    });
    presetSection.createDiv({
      cls: "sidebar-section-subtitle",
      text: this.tr(
        "支持新增、编辑、删除预设",
        "Add, edit, and delete presets",
      ),
    });
    const presetControls = presetSection.createDiv("sidebar-preset-controls");

    this.presetSelect = presetControls.createEl("select", {
      cls: "canvas-ai-preset-select",
    });

    const presetActions = presetControls.createDiv("sidebar-preset-actions");

    this.presetManageBtn = presetActions.createEl("button", {
      cls: "canvas-ai-preset-manage-btn",
      text: this.tr("新增 / 编辑", "Add / Edit"),
    });

    this.presetDeleteBtn = presetActions.createEl("button", {
      cls: "canvas-ai-preset-delete-btn",
      text: this.tr("删除预设", "Delete Preset"),
    });

    const recentWrap = presetSection.createDiv("sidebar-recent-presets");
    const recentHeader = recentWrap.createDiv("sidebar-recent-presets-header");
    recentHeader.createDiv({
      cls: "sidebar-recent-presets-title",
      text: this.tr("最近预设", "Recent Presets"),
    });
    this.viewAllPresetsBtn = recentHeader.createEl("button", {
      cls: "sidebar-view-all-presets-btn",
      text: this.tr("查看更多", "View All"),
    });
    this.recentPresetsListEl = recentWrap.createDiv(
      "sidebar-recent-presets-list",
    );

    const paramsSection = zone1.createDiv("sidebar-params-section");
    paramsSection.createDiv({
      cls: "sidebar-section-title",
      text: this.tr("参数设置", "Parameters"),
    });
    paramsSection.createDiv({
      cls: "sidebar-section-subtitle",
      text: this.tr(
        "模型 / 分辨率 / 长宽比",
        "Model / Resolution / Aspect Ratio",
      ),
    });

    const optionsRow = paramsSection.createDiv("canvas-ai-image-options");

    const modelGroup = optionsRow.createDiv("canvas-ai-option-group");
    modelGroup.createEl("label", { text: this.tr("模型", "Model") });
    this.imageModelSelect = modelGroup.createEl("select", {
      cls: "canvas-ai-image-model-select",
    });

    const resolutionGroup = optionsRow.createDiv("canvas-ai-option-group");
    resolutionGroup.createEl("label", {
      text: this.tr("分辨率", "Resolution"),
    });
    this.resolutionSelect = resolutionGroup.createEl("select");
    ["1K", "2K", "4K"].forEach((v) => {
      this.resolutionSelect.createEl("option", { value: v, text: v });
    });

    const aspectGroup = optionsRow.createDiv("canvas-ai-option-group");
    aspectGroup.createEl("label", { text: this.tr("长宽比", "Aspect Ratio") });
    this.aspectRatioSelect = aspectGroup.createEl("select");
    ["1:1", "16:9", "9:16", "4:3", "3:4"].forEach((v) => {
      this.aspectRatioSelect.createEl("option", { value: v, text: v });
    });

    const countGroup = optionsRow.createDiv("canvas-ai-option-group");
    countGroup.createEl("label", { text: this.tr("张数", "Count") });
    this.imageCountSelect = countGroup.createEl("select");
    Array.from({ length: 9 }, (_, i) => i + 1).forEach((n) => {
      this.imageCountSelect.createEl("option", {
        value: String(n),
        text: String(n),
      });
    });


    const zone2 = footer.createDiv("sidebar-zone-2");
    const zone2Header = zone2.createDiv("sidebar-zone-2-header");
    zone2Header.createDiv({
      cls: "sidebar-section-title",
      text: this.tr("自定义输入", "Custom Input"),
    });

    const zone2Actions = zone2Header.createDiv("sidebar-zone-2-actions");
    const img2imgSwitchWrap = zone2Actions.createDiv(
      "sidebar-img2img-switch-wrap",
    );
    img2imgSwitchWrap.createDiv({
      cls: "sidebar-img2img-switch-label",
      text: this.tr("图生图", "Image-to-Image"),
    });
    this.imageToImageToggleBtn = img2imgSwitchWrap.createEl("button", {
      cls: "sidebar-img2img-switch",
      attr: {
        type: "button",
        "aria-label": this.tr("图生图开关", "Image-to-Image Switch"),
        "aria-pressed": "false",
      },
    });
    this.imageToImageToggleBtn.createSpan({
      cls: "sidebar-img2img-switch-knob",
    });
    this.imageToImageStateEl = img2imgSwitchWrap.createDiv({
      cls: "sidebar-img2img-switch-state",
      text: this.tr("关", "Off"),
    });

    const hintWrap = zone2Actions.createDiv("sidebar-hint-wrap");
    const hintBtn = hintWrap.createEl("button", {
      cls: "sidebar-hint-btn",
      attr: { "aria-label": this.tr("使用提示", "Usage Tip"), type: "button" },
    });
    setIcon(hintBtn, "info");
    hintWrap.createDiv({
      cls: "sidebar-hint-tooltip",
      text: this.tr(
        "输入需求后点击生成；从候选图中选择并插入到笔记。可用 @current_note 自动引用当前笔记内容。",
        "Enter prompt and click Generate; then choose a candidate and insert into note. Use @current_note to inject current note context.",
      ),
    });

    this.generationStatusEl = zone2Header.createDiv({
      cls: "sidebar-generation-status is-idle",
      text: "",
    });

    const modeRow = zone2.createDiv("sidebar-zone-2-mode-row");

    this.imageToImagePanelEl = modeRow.createDiv(
      "sidebar-img2img-panel is-hidden",
    );
    this.imageToImageUploadBtn = this.imageToImagePanelEl.createEl("button", {
      cls: "sidebar-img2img-upload-btn",
      text: this.tr("参考图", "Reference"),
      attr: { type: "button" },
    });
    this.imageToImagePreviewWrapEl = this.imageToImagePanelEl.createDiv({
      cls: "sidebar-img2img-preview-wrap",
    });
    this.imageToImagePreviewEl = this.imageToImagePreviewWrapEl.createEl(
      "img",
      {
        cls: "sidebar-img2img-preview",
        attr: { alt: this.tr("参考图预览", "Reference Preview") },
      },
    );
    this.imageToImageFileNameEl = this.imageToImagePreviewWrapEl.createDiv({
      cls: "sidebar-img2img-file-name",
      text: this.tr("未选择图片", "No image selected"),
    });
    this.imageToImageClearBtn = this.imageToImagePanelEl.createEl("button", {
      cls: "sidebar-img2img-clear-btn",
      text: this.tr("清空", "Clear"),
      attr: { type: "button" },
    });
    this.imageToImageFileInput = this.imageToImagePanelEl.createEl("input", {
      cls: "sidebar-img2img-file-input",
      attr: { type: "file", accept: "image/*" },
    });

    const inputRow = zone2.createDiv("sidebar-zone-2-row");

    this.inputEl = inputRow.createEl("textarea", {
      cls: "canvas-ai-prompt-input sidebar-horizontal-input",
      attr: {
        placeholder: this.tr(
          "输入你要生成的图片描述（可结合预设，支持 @current_note）",
          "Describe the image you want to generate (optional with preset, supports @current_note)",
        ),
        rows: "3",
      },
    });

    const actionCol = inputRow.createDiv("sidebar-zone-2-action-col");

    this.optimizePromptBtn = actionCol.createEl("button", {
      cls: "canvas-ai-optimize-btn sidebar-horizontal-optimize-btn",
      text: this.tr("优化", "Optimize"),
      attr: { type: "button" },
    });

    this.generateBtn = actionCol.createEl("button", {
      cls: "canvas-ai-generate-btn sidebar-horizontal-generate-btn",
      text: this.tr("生成", "Generate"),
    });

    this.cancelBtn = actionCol.createEl("button", {
      cls: "canvas-ai-cancel-btn sidebar-horizontal-cancel-btn",
      text: this.tr("取消", "Cancel"),
    });

    this.messagesContainer = container.createDiv(
      "sidebar-image-log sidebar-image-log-hidden",
    );
  }

  private setupEvents(): void {
    this.presetSelect.addEventListener("change", () => {
      const selectedId = this.presetSelect.value;
      this.presetDeleteBtn.disabled = !selectedId;

      const selected = this.imagePresets.find((p) => p.id === selectedId);
      if (selected) {
        this.setInputPromptValue(selected.prompt || "", {
          persist: false,
          updateState: false,
        });
      }
      this.renderRecentPresets();
      this.queuePersistSidebarState();
      this.updateGenerateButtonState();
    });

    this.presetManageBtn.addEventListener("click", () => {
      this.openPresetEditor();
    });

    this.viewAllPresetsBtn.addEventListener("click", () => {
      this.openPresetBrowser();
    });

    this.presetDeleteBtn.addEventListener("click", () => {
      void this.handleDeletePreset();
    });

    this.imageModelSelect.addEventListener("change", () => {
      this.selectedImageModel = this.imageModelSelect.value;
      this.plugin.settings.paletteImageModel = this.selectedImageModel;
      void this.plugin.saveSettings();
    });

    this.resolutionSelect.addEventListener("change", () => {
      this.plugin.settings.defaultResolution = this.resolutionSelect.value;
      void this.plugin.saveSettings();
    });

    this.aspectRatioSelect.addEventListener("change", () => {
      this.plugin.settings.defaultAspectRatio = this.aspectRatioSelect.value;
      void this.plugin.saveSettings();
    });

    this.imageCountSelect.addEventListener("change", () => {
      const count = Number.parseInt(this.imageCountSelect.value, 10);
      this.plugin.settings.defaultImageCount =
        Number.isFinite(count) && count >= 1 && count <= 9 ? count : 4;
      void this.plugin.saveSettings();
    });


    this.generateBtn.addEventListener("click", () => {
      void this.handleGenerate();
    });

    this.inputEl.addEventListener("input", () => {
      const normalized = this.normalizeCurrentNoteShortcut(this.inputEl.value);
      if (normalized !== this.inputEl.value) {
        const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
        this.inputEl.value = normalized;
        const nextCursor = Math.min(
          cursor + ("@current_note".length - 1),
          normalized.length,
        );
        this.inputEl.setSelectionRange(nextCursor, nextCursor);
      }
      this.enforceReferenceLineLock();
      this.autoResizePromptInput();
      this.queuePersistSidebarState();
      this.updateGenerateButtonState();
    });

    this.cancelBtn.addEventListener("click", () => {
      this.generationQueue.cancelCurrentGeneration();
    });

    this.optimizePromptBtn.addEventListener("click", () => {
      this.handleOptimizePrompt();
    });

    this.imageToImageToggleBtn.addEventListener("click", () => {
      this.setImageToImageMode(!this.isImageToImageEnabled);
    });

    this.imageToImageUploadBtn.addEventListener("click", (event) => {
      this.openAddReferenceMenu(event);
    });

    this.imageToImageFileInput.addEventListener("change", () => {
      void this.handleReferenceImageFileChange();
    });

    this.imageToImageClearBtn.addEventListener("click", () => {
      this.clearAllReferenceImages();
    });

    this.imageToImagePreviewWrapEl.addEventListener("click", () => {
      if (this.referencePreviewObjectUrl && this.uploadedReferenceImage) {
        const modal = new ReferenceImagePreviewModal(
          this.app,
          this.referencePreviewObjectUrl,
          this.uploadedReferenceImage.fileName,
        );
        modal.open();
        return;
      }
      if (!this.imageToImageUploadBtn.disabled) {
        this.imageToImageFileInput.value = "";
        this.imageToImageFileInput.click();
      }
    });

    this.imageToImagePreviewWrapEl.addEventListener("dragover", (event) => {
      if (!this.canAcceptReferenceImageDrop()) return;
      event.preventDefault();
      this.imageToImagePreviewWrapEl.addClass("is-drag-over");
    });

    this.imageToImagePreviewWrapEl.addEventListener("dragleave", (event) => {
      if (!this.canAcceptReferenceImageDrop()) return;
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && this.imageToImagePreviewWrapEl.contains(nextTarget)) {
        return;
      }
      this.imageToImagePreviewWrapEl.removeClass("is-drag-over");
    });

    this.imageToImagePreviewWrapEl.addEventListener("drop", (event) => {
      if (!this.canAcceptReferenceImageDrop()) return;
      event.preventDefault();
      this.imageToImagePreviewWrapEl.removeClass("is-drag-over");
      const droppedFile = event.dataTransfer?.files?.[0];
      if (!droppedFile) return;
      void this.processReferenceImageFile(droppedFile);
    });
  }

  private initFromSettings(): void {
    this.imagePresets = [...(this.plugin.settings.imagePresets || [])];
    const supportedProviders = new Set([
      "openrouter",
      "openai",
      "gemini",
    ]);
    this.quickSwitchImageModels = [
      ...(this.plugin.settings.quickSwitchImageModels || []),
    ].filter((m) => supportedProviders.has(String(m.provider || "")));

    if (
      this.quickSwitchImageModels.length !==
      (this.plugin.settings.quickSwitchImageModels || []).length
    ) {
      this.plugin.settings.quickSwitchImageModels = [
        ...this.quickSwitchImageModels,
      ];
      void this.plugin.saveSettings();
    }

    const rawSelectedModel = this.plugin.settings.paletteImageModel || "";
    const selectedModelProvider = rawSelectedModel.split("|")[0] || "";
    this.selectedImageModel = supportedProviders.has(selectedModelProvider)
      ? rawSelectedModel
      : "";

    if (rawSelectedModel !== this.selectedImageModel) {
      this.plugin.settings.paletteImageModel = this.selectedImageModel;
      void this.plugin.saveSettings();
    }

    this.rebuildPresetSelect();
    this.rebuildImageModelSelect();

    this.resolutionSelect.value =
      this.plugin.settings.defaultResolution || "1K";
    this.aspectRatioSelect.value =
      this.plugin.settings.defaultAspectRatio || "1:1";

    const savedCount = this.plugin.settings.defaultImageCount || 4;
    const safeCount = Math.min(9, Math.max(1, savedCount));
    this.imageCountSelect.value = String(safeCount);
    this.plugin.settings.defaultImageCount = safeCount;


    const savedPresetId = this.plugin.settings.sidebarSelectedPresetId || "";
    if (
      savedPresetId &&
      this.imagePresets.some((p) => p.id === savedPresetId)
    ) {
      this.presetSelect.value = savedPresetId;
      this.presetDeleteBtn.disabled = false;
    } else {
      this.presetSelect.value = "";
      this.presetDeleteBtn.disabled = true;
    }
    this.renderRecentPresets();

    this.setInputPromptValue(this.plugin.settings.sidebarDraftPrompt || "", {
      persist: false,
      updateState: false,
    });
    this.updateImageToImageControls();
    this.updateGenerateButtonState();
  }

  private renderRecentPresets(): void {
    if (!this.recentPresetsListEl) return;
    this.recentPresetsListEl.empty();

    if (this.imagePresets.length === 0) {
      this.recentPresetsListEl.createDiv({
        cls: "sidebar-recent-presets-empty",
        text: this.tr("暂无预设", "No presets yet"),
      });
      return;
    }

    const selectedId = this.presetSelect?.value || "";
    const recentPresets = [...this.imagePresets].slice(-6).reverse();
    recentPresets.forEach((preset, index) => {
      const item = this.recentPresetsListEl.createEl("button", {
        cls: "sidebar-recent-preset-item",
        text: preset.name,
      });
      if (preset.id === selectedId) {
        item.addClass("is-active");
      }

      if (index === 0) {
        item.addClass("is-latest");
        item.setAttribute("title", this.tr("最近添加", "Recently added"));
      }

      item.addEventListener("click", () => {
        this.presetSelect.value = preset.id;
        this.presetDeleteBtn.disabled = false;
        this.setInputPromptValue(preset.prompt || "", {
          persist: false,
          updateState: false,
        });
        this.renderRecentPresets();
        this.queuePersistSidebarState();
        this.updateGenerateButtonState();
      });
    });
  }

  private rebuildPresetSelect(selectedId: string = ""): void {
    this.presetSelect.empty();

    this.presetSelect.createEl("option", {
      value: "",
      text: this.tr("选择预设（可选）", "Select preset (optional)"),
    });

    this.imagePresets.forEach((preset) => {
      this.presetSelect.createEl("option", {
        value: preset.id,
        text: preset.name,
      });
    });

    if (selectedId) {
      this.presetSelect.value = selectedId;
    }

    if (this.presetDeleteBtn) {
      this.presetDeleteBtn.disabled = !this.presetSelect.value;
    }

    this.renderRecentPresets();
  }

  private rebuildImageModelSelect(): void {
    this.imageModelSelect.empty();

    this.imageModelSelect.createEl("option", {
      value: "",
      text: this.tr("使用默认模型", "Use default model"),
    });

    this.quickSwitchImageModels.forEach((m) => {
      const label = `${m.provider}/${m.modelId}`;
      this.imageModelSelect.createEl("option", {
        value: `${m.provider}|${m.modelId}`,
        text: label,
      });
    });

    if (this.selectedImageModel) {
      this.imageModelSelect.value = this.selectedImageModel;
    }
  }

  private openPresetBrowser(): void {
    const modal = new PresetBrowserModal(
      this.app,
      this.imagePresets,
      (preset) => {
        this.presetSelect.value = preset.id;
        this.presetDeleteBtn.disabled = false;
        this.setInputPromptValue(preset.prompt || "", {
          persist: false,
          updateState: false,
        });
        this.queuePersistSidebarState();
        this.updateGenerateButtonState();
      },
    );
    modal.open();
  }

  private openPresetEditor(): void {
    const modal = new PresetEditorModal(
      this.app,
      this.imagePresets,
      this.presetSelect?.value || "",
      async ({ selectedId, name, prompt }) => {
        let idToSelect = selectedId;

        if (selectedId) {
          const target = this.imagePresets.find((p) => p.id === selectedId);
          if (target) {
            target.name = name;
            target.prompt = prompt;
          } else {
            idToSelect = "";
          }
        }

        if (!idToSelect) {
          const existedByName = this.imagePresets.find((p) => p.name === name);
          if (existedByName) {
            existedByName.prompt = prompt;
            idToSelect = existedByName.id;
          } else {
            const created: PromptPreset = {
              id: this.generatePresetId(),
              name,
              prompt,
            };
            this.imagePresets.push(created);
            idToSelect = created.id;
          }
        }

        this.plugin.settings.imagePresets = [...this.imagePresets];
        await this.plugin.saveSettings();

        this.rebuildPresetSelect(idToSelect);
        this.setInputPromptValue(prompt, {
          persist: false,
          updateState: false,
        });
        this.plugin.settings.sidebarSelectedPresetId = idToSelect;
        this.plugin.settings.sidebarDraftPrompt = this.inputEl.value;
        await this.plugin.saveSettings();
        this.updateGenerateButtonState();
        new Notice(this.tr("预设已保存", "Preset saved"));
      },
    );

    modal.open();
  }

  private async handleDeletePreset(): Promise<void> {
    const selectedId = this.presetSelect?.value || "";
    if (!selectedId) {
      new Notice(this.tr("请先选择一个预设", "Please select a preset first"));
      return;
    }

    const target = this.imagePresets.find((p) => p.id === selectedId);
    if (!target) {
      new Notice(this.tr("未找到预设", "Preset not found"));
      return;
    }

    const ok = window.confirm(
      this.tr(
        `确定删除预设「${target.name}」吗？`,
        `Delete preset "${target.name}"?`,
      ),
    );
    if (!ok) return;

    this.imagePresets = this.imagePresets.filter((p) => p.id !== selectedId);
    this.plugin.settings.imagePresets = [...this.imagePresets];
    await this.plugin.saveSettings();

    this.rebuildPresetSelect("");
    this.setInputPromptValue("", { persist: false, updateState: false });
    this.plugin.settings.sidebarSelectedPresetId = "";
    this.plugin.settings.sidebarDraftPrompt = this.inputEl.value;
    await this.plugin.saveSettings();
    this.updateGenerateButtonState();
    new Notice(this.tr("预设已删除", "Preset deleted"));
  }

  private generatePresetId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  private autoResizePromptInput(): void {
    if (!this.inputEl) return;

    const minHeight = 120;
    const maxHeight = 360;

    this.inputEl.style.height = "auto";
    const next = Math.min(
      maxHeight,
      Math.max(minHeight, this.inputEl.scrollHeight),
    );
    this.inputEl.style.height = String(next) + "px";
    this.inputEl.style.overflowY =
      this.inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  private setImageToImageMode(enabled: boolean): void {
    this.isImageToImageEnabled = enabled;
    this.updateImageToImageControls();
    this.updateGenerateButtonState();
  }

  private updateImageToImageControls(): void {
    if (!this.imageToImageToggleBtn || !this.imageToImagePanelEl) return;

    this.imageToImageToggleBtn.toggleClass(
      "is-active",
      this.isImageToImageEnabled,
    );
    this.imageToImageToggleBtn.setAttr(
      "aria-pressed",
      this.isImageToImageEnabled ? "true" : "false",
    );
    if (this.imageToImageStateEl) {
      this.imageToImageStateEl.textContent = this.isImageToImageEnabled
        ? this.tr("开", "On")
        : this.tr("关", "Off");
      this.imageToImageStateEl.toggleClass(
        "is-active",
        this.isImageToImageEnabled,
      );
    }

    this.imageToImagePanelEl.toggleClass(
      "is-hidden",
      !this.isImageToImageEnabled,
    );

    const uploadedIsPrimary = this.isUploadedReferencePrimary();
    const fileName =
      this.getPrimaryReferenceName() ||
      this.tr("未选择图片", "No image selected");
    if (this.imageToImageFileNameEl) {
      this.imageToImageFileNameEl.textContent = fileName;
      this.imageToImageFileNameEl.toggleClass(
        "has-file",
        Boolean(this.getPrimaryReferenceName()),
      );
    }
    if (this.imageToImagePreviewWrapEl) {
      this.imageToImagePreviewWrapEl.toggleClass(
        "has-file",
        Boolean(
          uploadedIsPrimary &&
          this.uploadedReferenceImage &&
          this.referencePreviewObjectUrl,
        ),
      );
      this.imageToImagePreviewWrapEl.toggleClass(
        "is-disabled",
        this.imageToImageUploadBtn?.disabled ?? false,
      );
      this.imageToImagePreviewWrapEl.setAttr(
        "title",
        uploadedIsPrimary && this.uploadedReferenceImage
          ? this.tr(
              "点击查看大图，也可拖拽替换",
              "Click to preview, or drag to replace",
            )
          : this.tr(
              "点击或拖拽上传参考图",
              "Click or drag to upload a reference image",
            ),
      );
    }

    if (this.imageToImageClearBtn) {
      this.imageToImageClearBtn.disabled =
        !this.uploadedReferenceImage &&
        this.selectedReferenceImages.length === 0;
    }
  }

  private async handleReferenceImageFileChange(): Promise<void> {
    const file = this.imageToImageFileInput?.files?.[0];
    if (!file) return;
    await this.processReferenceImageFile(file);
  }

  private canAcceptReferenceImageDrop(): boolean {
    return Boolean(
      this.isImageToImageEnabled &&
      this.imageToImagePanelEl &&
      !this.imageToImagePanelEl.hasClass("is-hidden") &&
      !this.imageToImageUploadBtn?.disabled,
    );
  }

  private async processReferenceImageFile(file: File): Promise<void> {
    if (!this.isImageFile(file)) {
      new Notice(this.tr("仅支持图片文件", "Only image files are supported"));
      return;
    }

    try {
      const dataUrl = await this.readFileAsDataUrl(file);
      const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
      if (!match) {
        throw new Error("invalid_image_data");
      }

      this.uploadedReferenceImage = {
        base64: match[2],
        mimeType: match[1] || file.type || "image/png",
        role: "reference",
        fileName: file.name,
      };
      this.primaryReferenceSource = "uploaded";
      this.setReferencePreviewObjectUrl(URL.createObjectURL(file));
      this.syncReferenceImageNameToPrompt(this.getPrimaryReferenceName());
      this.updateImageToImageControls();
      this.updateGenerateButtonState();
      new Notice(this.tr("已加载参考图", "Reference image loaded"));
    } catch (error) {
      console.error("Sidebar CoPilot: failed to read reference image", error);
      this.clearReferenceImage();
      this.updateGenerateButtonState();
      new Notice(
        this.tr(
          "参考图读取失败，请重试",
          "Failed to read reference image, please retry",
        ),
      );
    }
  }

  private isImageFile(file: File): boolean {
    if (file.type?.startsWith("image/")) return true;
    return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name || "");
  }

  private clearReferenceImage(): void {
    const shouldFallbackToNote =
      this.primaryReferenceSource === "uploaded" &&
      this.selectedReferenceImages.length > 0;
    this.uploadedReferenceImage = null;
    this.imageToImageFileInput.value = "";
    this.primaryReferenceSource = shouldFallbackToNote ? "note" : null;
    this.setReferencePreviewObjectUrl(null);
    this.syncReferenceImageNameToPrompt(this.getPrimaryReferenceName());
    this.updateImageToImageControls();
    this.updateGenerateButtonState();
  }

  private clearAllReferenceImages(): void {
    this.selectedReferenceImages = [];
    this.primaryReferenceSource = null;
    this.clearReferenceImage();
  }

  private async openNoteImagePicker(): Promise<void> {
    const options = await this.collectCurrentNoteImageOptions();
    const preselected = new Set(
      this.selectedReferenceImages
        .map((item) => item.sourcePath || "")
        .filter((v) => Boolean(v)),
    );

    const modal = new NoteImagePickerModal(
      this.app,
      options,
      preselected,
      (paths) => {
        void this.applySelectedNoteImages(paths);
      },
    );
    modal.open();
  }

  private openAddReferenceMenu(event: MouseEvent): void {
    if (!this.isImageToImageEnabled) {
      this.setImageToImageMode(true);
    }

    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(this.tr("从本地上传", "Upload from Local"))
        .setIcon("upload")
        .onClick(() => {
          this.imageToImageFileInput.value = "";
          this.imageToImageFileInput.click();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle(this.tr("从当前笔记选择", "Select from Current Note"))
        .setIcon("image-file")
        .onClick(() => {
          void this.openNoteImagePicker();
        });
    });
    menu.showAtMouseEvent(event);
  }

  private getPrimaryReferenceName(): string | null {
    if (
      this.primaryReferenceSource === "note" &&
      this.selectedReferenceImages[0]?.fileName
    ) {
      return this.selectedReferenceImages[0].fileName;
    }
    if (
      this.primaryReferenceSource === "uploaded" &&
      this.uploadedReferenceImage?.fileName
    ) {
      return this.uploadedReferenceImage.fileName;
    }
    if (this.selectedReferenceImages[0]?.fileName) {
      return this.selectedReferenceImages[0].fileName;
    }
    if (this.uploadedReferenceImage?.fileName) {
      return this.uploadedReferenceImage.fileName;
    }
    return null;
  }

  private isUploadedReferencePrimary(): boolean {
    if (!this.uploadedReferenceImage) return false;
    if (this.primaryReferenceSource === "note") return false;
    return true;
  }

  private async applySelectedNoteImages(paths: string[]): Promise<void> {
    const next: SidebarInputImage[] = [];
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        const data = await this.app.vault.readBinary(file);
        const bytes = new Uint8Array(data);
        const base64 = this.encodeBytesToBase64(bytes);
        next.push({
          base64,
          mimeType: this.getMimeTypeByFileName(file.name),
          role: "reference",
          fileName: file.name,
          sourcePath: file.path,
        });
      } catch (error) {
        console.warn("Sidebar CoPilot: failed to read note image", path, error);
      }
    }
    this.selectedReferenceImages = next;
    if (next.length > 0) {
      this.uploadedReferenceImage = null;
      this.imageToImageFileInput.value = "";
      this.setReferencePreviewObjectUrl(null);
      this.primaryReferenceSource = "note";
    } else if (!this.uploadedReferenceImage) {
      this.primaryReferenceSource = null;
    }
    this.syncReferenceImageNameToPrompt(this.getPrimaryReferenceName());
    this.updateImageToImageControls();
    this.updateGenerateButtonState();
    if (next.length > 0) {
      new Notice(
        this.tr(
          `已选择 ${next.length} 张参考图`,
          `${next.length} reference image(s) selected`,
        ),
      );
    }
  }

  private encodeBytesToBase64(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";
    const chunkSize = 0x8000;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      parts.push(String.fromCharCode(...chunk));
    }
    return btoa(parts.join(""));
  }

  private async collectCurrentNoteImageOptions(): Promise<NoteImageOption[]> {
    const file =
      this.app.workspace.getActiveFile() || this.capturedContext?.file;
    if (!file || file.extension !== "md") {
      new Notice(
        this.tr(
          "请先激活一个 Markdown 笔记",
          "Please activate a Markdown note first",
        ),
      );
      return [];
    }
    const content = await this.app.vault.read(file);
    const refs = this.extractImageRefsFromContent(content);
    const unique = new Set<string>();
    const results: NoteImageOption[] = [];

    for (const rawPath of refs) {
      const resolved = this.resolveCandidateImagePath(file.path, rawPath);
      if (!resolved || unique.has(resolved)) continue;
      const abstract = this.app.vault.getAbstractFileByPath(resolved);
      if (!(abstract instanceof TFile)) continue;
      unique.add(resolved);
      results.push({
        path: resolved,
        fileName: abstract.name,
        previewSrc: this.app.vault.getResourcePath(abstract),
      });
    }
    return results;
  }

  private extractImageRefsFromContent(content: string): string[] {
    const refs: string[] = [];
    const obsidianRegex = /!\[\[([^\]]+)\]\]/gi;
    const markdownRegex =
      /!\[[^\]]*]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)[^)]*)\)/gi;
    let match: RegExpExecArray | null = null;
    while ((match = obsidianRegex.exec(content)) !== null) {
      const cleaned = this.normalizeObsidianImageTarget(match[1] || "");
      if (cleaned) refs.push(cleaned);
    }
    while ((match = markdownRegex.exec(content)) !== null) {
      const cleaned = this.normalizeMarkdownImageTarget(match[1] || "");
      if (cleaned) refs.push(cleaned);
    }
    return refs;
  }

  private normalizeObsidianImageTarget(rawTarget: string): string {
    const trimmed = (rawTarget || "").trim();
    if (!trimmed) return "";
    const withoutAlias = trimmed.split("|")[0]?.trim() || "";
    const withoutAnchor = withoutAlias.split("#")[0]?.trim() || "";
    if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(withoutAnchor)) return "";
    return withoutAnchor;
  }

  private normalizeMarkdownImageTarget(rawTarget: string): string {
    const trimmed = rawTarget.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("<") && trimmed.includes(">")) {
      return trimmed.slice(1, trimmed.indexOf(">")).trim();
    }
    return trimmed.split(/\s+/)[0] || "";
  }

  private resolveCandidateImagePath(
    notePath: string,
    rawPath: string,
  ): string | null {
    const normalized = rawPath.replace(/^\/+/, "").trim();

    const resolvedByLink = this.app.metadataCache.getFirstLinkpathDest(
      normalized,
      notePath,
    );
    if (resolvedByLink instanceof TFile) {
      return resolvedByLink.path;
    }

    if (this.app.vault.getAbstractFileByPath(normalized)) {
      return normalized;
    }
    const dir = notePath.includes("/")
      ? notePath.slice(0, notePath.lastIndexOf("/"))
      : "";
    const relative = dir ? `${dir}/${normalized}` : normalized;
    if (this.app.vault.getAbstractFileByPath(relative)) {
      return relative;
    }
    return null;
  }

  private getMimeTypeByFileName(fileName: string): string {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    if (ext === "bmp") return "image/bmp";
    if (ext === "svg") return "image/svg+xml";
    return "image/png";
  }

  private syncReferenceImageNameToPrompt(fileName: string | null): void {
    if (!this.inputEl) return;
    const current = this.inputEl.value || "";
    const next = this.composePromptWithReferenceLine(current, fileName);
    if (next === current) return;
    this.inputEl.value = next;
    this.autoResizePromptInput();
    this.queuePersistSidebarState();
    this.updateGenerateButtonState();
  }

  private composePromptWithReferenceLine(
    prompt: string,
    fileName: string | null,
  ): string {
    const lines = (prompt || "").split("\n");
    const bodyLines = lines.filter(
      (line) => !line.trimStart().startsWith(this.referencePromptPrefix),
    );
    if (fileName) {
      return [`${this.referencePromptPrefix}${fileName}`, ...bodyLines].join(
        "\n",
      );
    }
    return bodyLines.join("\n");
  }

  private enforceReferenceLineLock(): void {
    if (!this.inputEl || !this.isImageToImageEnabled) return;
    const primaryRefName = this.getPrimaryReferenceName();
    if (!primaryRefName) return;

    const current = this.inputEl.value || "";
    const next = this.composePromptWithReferenceLine(current, primaryRefName);
    if (next === current) return;

    const cursor = this.inputEl.selectionStart ?? current.length;
    const firstLineBreak = current.indexOf("\n");
    const bodyOffset =
      firstLineBreak >= 0 && current.startsWith(this.referencePromptPrefix)
        ? Math.max(0, cursor - (firstLineBreak + 1))
        : cursor;

    this.inputEl.value = next;

    const nextBody = this.composePromptWithReferenceLine(next, null);
    const safeBodyOffset = Math.min(bodyOffset, nextBody.length);
    const prefixLen = `${this.referencePromptPrefix}${primaryRefName}`.length;
    const nextCursor =
      safeBodyOffset > 0 ? prefixLen + 1 + safeBodyOffset : prefixLen;
    this.inputEl.setSelectionRange(nextCursor, nextCursor);
  }

  private setReferencePreviewObjectUrl(nextUrl: string | null): void {
    if (this.referencePreviewObjectUrl) {
      URL.revokeObjectURL(this.referencePreviewObjectUrl);
    }
    this.referencePreviewObjectUrl = nextUrl;
    if (!this.imageToImagePreviewEl) return;
    if (nextUrl) {
      this.imageToImagePreviewEl.src = nextUrl;
      return;
    }
    this.imageToImagePreviewEl.removeAttribute("src");
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        if (!result) {
          reject(new Error("empty_file"));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(reader.error || new Error("read_failed"));
      reader.readAsDataURL(file);
    });
  }

  private queuePersistSidebarState(): void {
    if (this.promptSaveTimer !== null) {
      window.clearTimeout(this.promptSaveTimer);
    }

    this.promptSaveTimer = window.setTimeout(() => {
      this.plugin.settings.sidebarDraftPrompt = this.inputEl?.value || "";
      this.plugin.settings.sidebarSelectedPresetId =
        this.presetSelect?.value || "";
      void this.plugin.saveSettings();
      this.promptSaveTimer = null;
    }, 220);
  }

  private setInputPromptValue(
    rawPrompt: string,
    options?: { persist?: boolean; updateState?: boolean },
  ): void {
    if (!this.inputEl) return;
    const persist = options?.persist ?? true;
    const updateState = options?.updateState ?? true;

    let next = this.normalizeCurrentNoteShortcut(rawPrompt || "");
    if (this.isImageToImageEnabled) {
      const refName = this.getPrimaryReferenceName();
      if (refName) {
        next = this.composePromptWithReferenceLine(next, refName);
      }
    }

    this.inputEl.value = next;
    this.autoResizePromptInput();
    if (persist) this.queuePersistSidebarState();
    if (updateState) this.updateGenerateButtonState();
  }

  private registerActiveFileListener(): void {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== "md") {
          this.capturedContext = null;
        }
        if (leaf?.view === this) {
          this.tryAutoFillFromSelection();
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, _view: MarkdownView) => {
          const selection = editor.getSelection();
          if (!selection?.trim()) return;
          menu.addItem((item) => {
            item
              .setTitle(this.tr("以选中文字生成图片", "Generate image from selection"))
              .setIcon("image")
              .onClick(() => {
                this.setInputPromptValue(selection.trim(), {
                  persist: false,
                  updateState: true,
                });
                this.app.workspace.revealLeaf(this.leaf);
              });
          });
        },
      ),
    );
  }

  private tryAutoFillFromSelection(): void {
    if (this.inputEl?.value.trim()) return;
    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) return;
    const context = notesHandler.captureSelectionForSidebar();
    if (context?.selectedText?.trim()) {
      this.setInputPromptValue(context.selectedText.trim(), {
        persist: false,
        updateState: true,
      });
    }
  }

  private updateGenerateButtonState(): void {
    if (!this.generateBtn) return;

    const hasRunning = this.generationQueue?.pendingTaskCount > 0;
    const explicitRefCount =
      (this.uploadedReferenceImage ? 1 : 0) +
      this.selectedReferenceImages.length;
    const imageRequiredMissing =
      this.isImageToImageEnabled && explicitRefCount === 0;
    const hasPrompt = Boolean(this.inputEl?.value.trim());
    this.generateBtn.disabled = hasRunning || imageRequiredMissing;
    this.cancelBtn.disabled = !hasRunning;
    this.cancelBtn.toggleClass("is-active", hasRunning);
    this.optimizePromptBtn.disabled = hasRunning || !hasPrompt;

    if (this.imageToImageToggleBtn) {
      this.imageToImageToggleBtn.disabled = hasRunning;
    }
    if (this.imageToImageUploadBtn) {
      this.imageToImageUploadBtn.disabled =
        hasRunning || !this.isImageToImageEnabled;
    }
    if (this.imageToImageFileInput) {
      this.imageToImageFileInput.disabled =
        hasRunning || !this.isImageToImageEnabled;
    }

    const readyCount = this.candidateManager?.getReadyCandidateCount() ?? 0;
    const isBulkInserting = this.candidateManager?.isBulkInserting ?? false;
    const failedCount = this.candidateManager?.failedTasks.length ?? 0;

    this.insertAllBtn.disabled =
      readyCount === 0 || hasRunning || isBulkInserting;
    this.insertAllBtn.textContent =
      readyCount > 0
        ? this.tr("一键插入全部", "Insert All") + " (" + readyCount + ")"
        : this.tr("一键插入全部", "Insert All");

    const hasFailed = failedCount > 0;
    this.retryFailedBtn.disabled = !hasFailed || hasRunning || isBulkInserting;
    this.retryFailedBtn.textContent = hasFailed
      ? this.tr("重试失败项", "Retry Failed") + " (" + failedCount + ")"
      : this.tr("重试失败项", "Retry Failed");

    if (!hasRunning) {
      this.generateBtn.textContent = this.tr("生成", "Generate");
      this.generateBtn.removeClass("generating");
      if (this.elapsedTimer !== null) {
        window.clearInterval(this.elapsedTimer);
        this.elapsedTimer = null;
        this.generationStartTime = null;
      }
      if (this.generationStatusEl) {
        if (hasFailed) {
          this.generationStatusEl.textContent = this.tr(
            "有 " + failedCount + " 项失败，可点击重试",
            failedCount + " failed item(s). Click Retry Failed.",
          );
          this.generationStatusEl.removeClass("is-running");
          this.generationStatusEl.addClass("is-idle");
        } else if (imageRequiredMissing) {
          this.generationStatusEl.textContent = this.tr(
            "图生图已开启，请先上传或选择参考图",
            "Image-to-Image is on. Upload or select a reference image first.",
          );
          this.generationStatusEl.removeClass("is-running");
          this.generationStatusEl.addClass("is-idle");
        } else {
          this.generationStatusEl.textContent = "";
          this.generationStatusEl.removeClass("is-running");
          this.generationStatusEl.addClass("is-idle");
        }
      }
      return;
    }

    if (this.generationStartTime === null) {
      this.generationStartTime = Date.now();
      this.elapsedTimer = window.setInterval(() => {
        this.updateGenerateButtonState();
      }, 1000);
    }

    const total =
      this.generationQueue.activeRequestTotal ||
      this.generationQueue.pendingTaskCount;
    const finished = Math.max(0, total - this.generationQueue.pendingTaskCount);
    this.generateBtn.textContent =
      this.tr("生成中", "Generating") + " " + finished + "/" + total;
    this.generateBtn.addClass("generating");

    if (this.generationStatusEl) {
      const running = Math.max(
        0,
        this.generationQueue.activeConcurrencyCount,
      );
      const elapsed = this.generationStartTime
        ? Math.floor((Date.now() - this.generationStartTime) / 1000)
        : 0;
      const elapsedStr =
        elapsed > 0
          ? " · " + elapsed + this.tr("秒", "s")
          : "";
      this.generationStatusEl.textContent =
        this.tr("并发进行中", "Running") +
        " " +
        running +
        this.tr(" 路，剩余 ", " concurrent, remaining ") +
        this.generationQueue.pendingTaskCount +
        " / " +
        total +
        elapsedStr;
      this.generationStatusEl.removeClass("is-idle");
      this.generationStatusEl.addClass("is-running");
    }
  }

  private hasCurrentNotePlaceholder(prompt: string): boolean {
    if (!prompt) return false;
    this.currentNoteShortcutPattern.lastIndex = 0;
    if (this.currentNoteShortcutPattern.test(prompt)) {
      this.currentNoteShortcutPattern.lastIndex = 0;
      return true;
    }
    this.currentNoteShortcutPattern.lastIndex = 0;
    this.currentNoteTokenPattern.lastIndex = 0;
    if (this.currentNoteTokenPattern.test(prompt)) {
      this.currentNoteTokenPattern.lastIndex = 0;
      return true;
    }
    this.currentNoteTokenPattern.lastIndex = 0;
    return this.currentNotePlaceholderTokens.some((token) =>
      prompt.includes(token),
    );
  }

  private getActiveMarkdownBasename(): string {
    const file =
      this.app.workspace.getActiveFile() || this.capturedContext?.file;
    if (!file || file.extension !== "md") return "";
    return file.basename || "";
  }

  private decorateCurrentNoteTokenWithName(prompt: string): string {
    if (!prompt) return prompt;
    const basename = this.getActiveMarkdownBasename();
    if (!basename) return prompt;

    let next = prompt;
    this.currentNoteTokenPattern.lastIndex = 0;
    next = next.replace(this.currentNoteTokenPattern, (match) => {
      if (/\([^)]+\)$/.test(match)) return match;
      return `@current_note(${basename})`;
    });
    this.currentNoteTokenPattern.lastIndex = 0;
    return next;
  }

  private normalizeCurrentNoteShortcut(prompt: string): string {
    if (!prompt) return prompt;
    const basename = this.getActiveMarkdownBasename();
    const replacement = basename
      ? `@current_note(${basename})`
      : "@current_note";
    this.currentNoteShortcutPattern.lastIndex = 0;
    const normalized = prompt.replace(
      this.currentNoteShortcutPattern,
      (_match, prefix: string) => `${prefix}${replacement}`,
    );
    return this.decorateCurrentNoteTokenWithName(normalized);
  }

  private stripMarkdownNoise(content: string): string {
    let next = content || "";
    next = next.replace(/^---\n[\s\S]*?\n---\n?/m, "");
    next = next.replace(/```[\s\S]*?```/g, " ");
    next = next.replace(/`[^`]*`/g, " ");
    return next;
  }

  private collapseSpaces(text: string): string {
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private summarizeNoteForPrompt(content: string): string {
    const cleaned = this.collapseSpaces(this.stripMarkdownNoise(content));
    if (!cleaned) return "";

    const lines = cleaned
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => Boolean(line));

    const ranked: string[] = [];
    const headings = lines
      .filter((line) => /^#{1,4}\s+/.test(line))
      .slice(0, 8)
      .map((line) => line.replace(/^#{1,4}\s+/, ""));
    const bullets = lines
      .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
      .slice(0, 12)
      .map((line) => line.replace(/^([-*]|\d+\.)\s+/, ""));
    const paragraphs = lines
      .filter(
        (line) => !/^#{1,4}\s+/.test(line) && !/^([-*]|\d+\.)\s+/.test(line),
      )
      .slice(0, 12);

    if (headings.length > 0) {
      ranked.push(this.tr("标题与章节：", "Headings and sections:"));
      headings.forEach((item) => ranked.push(`- ${item}`));
    }
    if (bullets.length > 0) {
      ranked.push(this.tr("关键要点：", "Key points:"));
      bullets.forEach((item) => ranked.push(`- ${item}`));
    }
    if (paragraphs.length > 0) {
      ranked.push(this.tr("正文摘要：", "Body summary:"));
      paragraphs.forEach((item) => ranked.push(`- ${item}`));
    }

    const merged = ranked.join("\n").trim() || cleaned.slice(0, 2000);
    const maxChars = 3200;
    if (merged.length <= maxChars) return merged;
    return `${merged.slice(0, maxChars)}\n...`;
  }

  private async injectCurrentNoteContentIntoPrompt(
    prompt: string,
    context: NotesSelectionContext | null,
  ): Promise<CurrentNoteInjectionResult> {
    if (!this.hasCurrentNotePlaceholder(prompt)) {
      return { prompt, replaced: false };
    }

    const noteFile = context?.file || this.app.workspace.getActiveFile();
    if (!noteFile || noteFile.extension !== "md") {
      throw new Error(
        this.tr(
          "使用 @current_note 需要先打开一个 Markdown 笔记",
          "Using @current_note requires an active Markdown note",
        ),
      );
    }

    const raw = await this.app.vault.read(noteFile);
    const summary = this.summarizeNoteForPrompt(raw);
    if (!summary) {
      throw new Error(
        this.tr(
          "当前笔记内容为空，无法从 @current_note 注入上下文",
          "Current note is empty, unable to inject context from @current_note",
        ),
      );
    }

    const injectedBlock = [
      this.tr("[当前笔记上下文]", "[Current Note Context]"),
      `${this.tr("笔记名", "Note title")}: ${noteFile.basename}`,
      `${this.tr("路径", "Path")}: ${noteFile.path}`,
      this.tr(
        "以下是自动提取的笔记摘要，请基于它完成本次生图：",
        "Auto-extracted note summary for this generation:",
      ),
      summary,
    ].join("\n");

    let nextPrompt = prompt;
    this.currentNoteTokenPattern.lastIndex = 0;
    nextPrompt = nextPrompt.replace(
      this.currentNoteTokenPattern,
      injectedBlock,
    );
    this.currentNoteTokenPattern.lastIndex = 0;
    this.currentNotePlaceholderTokens.forEach((token) => {
      nextPrompt = nextPrompt.split(token).join(injectedBlock);
    });
    return { prompt: nextPrompt, replaced: true };
  }

  private async handleGenerate(): Promise<void> {
    if (this.generationQueue.pendingTaskCount > 0) return;

    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) {
      new Notice(this.tr("笔记处理器不可用", "Notes handler unavailable"));
      return;
    }

    let promptDraft = this.inputEl.value || "";
    const normalizedShortcut = this.normalizeCurrentNoteShortcut(promptDraft);
    if (normalizedShortcut !== promptDraft) {
      promptDraft = normalizedShortcut;
      this.inputEl.value = normalizedShortcut;
      this.autoResizePromptInput();
      this.queuePersistSidebarState();
    }

    const refreshedContext = notesHandler.captureSelectionForSidebar();
    if (refreshedContext) {
      this.capturedContext = refreshedContext;
    }

    const inputImages: SidebarInputImage[] = this.isImageToImageEnabled
      ? [
          ...(this.uploadedReferenceImage ? [this.uploadedReferenceImage] : []),
          ...this.selectedReferenceImages,
        ]
      : [];

    if (this.isImageToImageEnabled && inputImages.length === 0) {
      new Notice(
        this.tr(
          "请先上传或选择参考图，再进行图生图",
          "Please upload or select a reference image before Image-to-Image.",
        ),
      );
      return;
    }

    const primaryRefName = this.getPrimaryReferenceName();
    if (this.isImageToImageEnabled && primaryRefName) {
      const normalized = this.composePromptWithReferenceLine(
        promptDraft,
        primaryRefName,
      );
      if (normalized !== promptDraft) {
        promptDraft = normalized;
        this.inputEl.value = normalized;
        this.autoResizePromptInput();
        this.queuePersistSidebarState();
      }
    }

    let injected = promptDraft;
    try {
      const injectedResult = await this.injectCurrentNoteContentIntoPrompt(
        promptDraft,
        this.capturedContext,
      );
      injected = injectedResult.prompt;
      if (injectedResult.replaced) {
        new Notice(
          this.tr(
            "已自动读取当前笔记内容并注入生成上下文",
            "Current note content has been injected into generation context",
          ),
        );
      }
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : this.generationQueue.formatImageError(error);
      new Notice(msg);
      return;
    }

    const rawPrompt = injected.trim();
    if (!rawPrompt && !this.capturedContext?.selectedText?.trim()) {
      new Notice(t("Enter instructions"));
      return;
    }

    const selectedCount = Number.parseInt(this.imageCountSelect.value, 10);
    const requestCount =
      Number.isFinite(selectedCount) && selectedCount >= 1 && selectedCount <= 9
        ? selectedCount
        : Math.min(9, Math.max(1, this.plugin.settings.defaultImageCount || 4));

    if (
      rawPrompt.includes(this.pptAutoMarker) ||
      rawPrompt.includes(this.pptAutoLegacyMarker)
    ) {
      const pageCount = this.extractPptPageCountFromPrompt(rawPrompt);
      const tasks = this.buildPptAutoGenerationTasks(
        rawPrompt,
        this.capturedContext,
        pageCount,
        requestCount,
        inputImages,
      );
      if (tasks.length === 0) {
        new Notice(
          this.tr(
            "PPT 自动拆页任务为空，请检查提示词",
            "PPT auto-split tasks are empty. Please check the prompt.",
          ),
        );
        return;
      }
      new Notice(
        this.tr(
          `已按 ${pageCount} 页拆解；每页 ${requestCount} 张候选，共 ${tasks.length} 个任务`,
          `Split into ${pageCount} pages; ${requestCount} candidate(s) per page, ${tasks.length} tasks in total`,
        ),
      );
      this.candidateManager.failedTasks = [];
      this.generationQueue.startGenerationTasks(tasks);
      return;
    }

    const prompt =
      this.isImageToImageEnabled && inputImages.length > 0
        ? this.buildStrictImg2ImgPrompt(rawPrompt)
        : rawPrompt;

    this.candidateManager.failedTasks = [];
    this.generationQueue.startGenerationBatch(
      prompt,
      this.capturedContext,
      requestCount,
      inputImages,
    );
  }

  private handleOptimizePrompt(): void {
    const current = this.inputEl?.value || "";
    const lines = current.split("\n");
    const hasRefLine =
      lines.length > 0 &&
      lines[0].trimStart().startsWith(this.referencePromptPrefix);
    const body = (hasRefLine ? lines.slice(1) : lines).join("\n").trim();

    if (!body) {
      new Notice(
        this.tr(
          "请先输入需要优化的提示词",
          "Please enter a prompt to optimize",
        ),
      );
      return;
    }

    if (this.isPptRequest(body)) {
      const primaryRefName = this.getPrimaryReferenceName();
      const optimizedPpt = this.buildOptimizedPptPrompt(body);
      this.inputEl.value =
        this.isImageToImageEnabled && primaryRefName
          ? this.composePromptWithReferenceLine(optimizedPpt, primaryRefName)
          : optimizedPpt;
      new Notice(
        this.tr(
          "已生成 PPT 自动拆页提示词（生成时按页拆解）",
          "Generated PPT auto-split prompt (generation will split by pages)",
        ),
      );
      this.autoResizePromptInput();
      this.queuePersistSidebarState();
      this.updateGenerateButtonState();
      return;
    }

    const primaryRefName = this.getPrimaryReferenceName();
    if (this.isImageToImageEnabled && primaryRefName) {
      const optimized = this.buildOptimizedImg2ImgPrompt(body);
      const refLine = `${this.referencePromptPrefix}${primaryRefName}`;
      this.inputEl.value = `${refLine}\n${optimized}`;
      new Notice(
        this.tr(
          "已生成保真优先的图生图提示词",
          "Generated an Image-to-Image prompt optimized for fidelity",
        ),
      );
    } else {
      this.inputEl.value = this.buildOptimizedTextToImagePrompt(body);
      new Notice(
        this.tr(
          "已生成结构化文生图提示词",
          "Generated a structured Text-to-Image prompt",
        ),
      );
    }
    this.autoResizePromptInput();
    this.queuePersistSidebarState();
    this.updateGenerateButtonState();
  }

  private buildOptimizedImg2ImgPrompt(userPrompt: string): string {
    const text = userPrompt.replace(/\s+/g, " ").trim();
    const hasLensConflict = /(85mm|特写|close[- ]?up|人像特写)/i.test(text);
    const hasSceneConflict =
      /(黑暗虚空|纯黑背景|彻底更换背景|换场景|dark void)/i.test(text);
    const hasIdentityConflict =
      /(换人|更换人物|不同的人|remove glasses|无眼镜|摘掉眼镜)/i.test(text);

    const conflictTips: string[] = [];
    if (hasIdentityConflict) {
      conflictTips.push(
        this.tr(
          "人物身份相关冲突：保持同一人物身份，不替换人物。",
          "Identity conflict: keep the same person identity, do not replace the person.",
        ),
      );
    }
    if (hasLensConflict) {
      conflictTips.push(
        this.tr(
          "镜头构图冲突：优先保留参考图机位，镜头变化仅做轻微调整。",
          "Lens/composition conflict: keep original camera angle; only minor lens adjustment.",
        ),
      );
    }
    if (hasSceneConflict) {
      conflictTips.push(
        this.tr(
          "场景冲突：优先保留原背景结构，只做氛围强化。",
          "Scene conflict: preserve original background structure and only enhance atmosphere.",
        ),
      );
    }

    const conflictSection =
      conflictTips.length > 0
        ? `${this.tr("冲突修正：", "Conflict fixes:")}\n- ${conflictTips.join("\n- ")}\n\n`
        : "";

    return [
      this.tr(
        "【图生图优化版（保真优先）】",
        "[Image-to-Image Optimized | Fidelity First]",
      ),
      this.tr(
        "必须以上传参考图为唯一视觉来源。",
        "Use the uploaded reference image as the only visual source.",
      ),
      this.tr(
        "先保留：人物身份、脸部结构、姿态与主体位置关系。",
        "Preserve first: identity, facial structure, pose, and subject composition.",
      ),
      this.tr(
        "再调整：材质特效、局部细节、氛围与光影。",
        "Then adjust: materials/effects, local details, atmosphere, and lighting.",
      ),
      this.tr(
        "禁止：替换人物、彻底重构场景、与参考图主体无关的改造。",
        "Do not: replace person, fully rebuild scene, or make unrelated transformations.",
      ),
      "",
      conflictSection + this.tr("用户目标效果：", "Target effect:"),
      text,
    ]
      .join("\n")
      .trim();
  }

  private buildOptimizedTextToImagePrompt(userPrompt: string): string {
    const text = userPrompt.replace(/\s+/g, " ").trim();
    return [
      this.tr("【文生图优化版】", "[Text-to-Image Optimized]"),
      this.tr(
        "请生成一张高质量、细节丰富、构图明确的图像。",
        "Generate a high-quality image with rich detail and clear composition.",
      ),
      this.tr(
        "输出要求：主体清晰、背景与主体关系明确、光线与色彩统一、材质细节可见。",
        "Requirements: clear subject, coherent background relation, consistent lighting/colors, visible material details.",
      ),
      this.tr(
        "请避免无关元素和文字水印。",
        "Avoid irrelevant elements and text watermarks.",
      ),
      "",
      this.tr("用户需求：", "User request:"),
      text,
      "",
      this.tr("补充建议：", "Optional suggestions:"),
      this.tr(
        "- 明确镜头与景别（近景/中景/远景）",
        "- Specify lens and shot size (close/mid/long shot)",
      ),
      this.tr("- 明确光线方向与氛围", "- Specify lighting direction and mood"),
      this.tr(
        "- 明确风格关键词（写实/电影感/插画等）",
        "- Specify style keywords (realistic/cinematic/illustration etc.)",
      ),
    ].join("\n");
  }

  private isPptRequest(text: string): boolean {
    if (!text) return false;
    return /(ppt|幻灯|课件|演示文稿|投影片|简报)/i.test(text);
  }

  private buildOptimizedPptPrompt(userPrompt: string): string {
    const text = userPrompt.replace(/\s+/g, " ").trim();
    const pageCount = this.extractPptPageCountFromPrompt(text);
    const aspectRatio = this.extractPreferredAspectRatioFromPrompt(text);
    const withCurrentNote =
      this.hasCurrentNotePlaceholder(text) || text.includes("@current_note(")
        ? text
        : `@current_note\n${text}`;
    const hasStyleConstraints =
      /(风格|样式|背景|配色|颜色|字体|serif|sans|grid|布局|图表|质感|Claude|Anthropic|humanism|palette|typography|style)/i.test(
        text,
      );

    const styleSection = hasStyleConstraints
      ? [
          this.tr("【风格策略】", "[Style Strategy]"),
          this.tr(
            "严格沿用并执行用户提示词中已有的风格、配色、字体、排版与图表要求；不要覆盖或改写。",
            "Strictly follow the style, palette, typography, layout, and chart requirements already defined by the user; do not override or rewrite them.",
          ),
        ]
      : [
          this.tr(
            "【风格兜底（仅在未提供风格时生效）】",
            "[Style Fallback (only if user did not specify)]",
          ),
          "Warm academic humanism, 16:9 single-slide output, card-based clean grid, readable Chinese typography.",
        ];

    return [
      this.pptAutoMarker,
      this.tr(
        `【PPT 自动拆页模式】生成时将自动拆成 ${pageCount} 页任务；参数"张数"=每页候选数。`,
        `[PPT Auto Split Mode] Generation will split into ${pageCount} page tasks; Image Count = candidates per page.`,
      ),
      this.tr(
        "请严格沿用用户提示词中的受众、语气、目标与内容要求，不要擅自改写定位。",
        "Strictly preserve the audience, tone, goals, and content requirements from the user prompt; do not rewrite positioning.",
      ),
      "",
      ...styleSection,
      this.tr("【通用质量约束】", "[General Quality Constraints]"),
      this.tr(
        `一页一图（建议比例 ${aspectRatio}，若用户另有要求则以用户提示词为准），不要多页拼接长图；信息密度按用户提示词执行，缺省时保持版面充实且可读性优先。`,
        `One slide per image (recommended ratio ${aspectRatio}, but user prompt takes priority), no multi-page long collage; follow user-defined information density, and keep slides content-rich and readable when unspecified.`,
      ),
      "",
      this.tr("【内容来源】", "[Content Source]"),
      withCurrentNote,
      "",
      this.tr("【页级拆分策略】", "[Page Split Strategy]"),
      this.tr(
        `按 ${pageCount} 页拆分并逐页生成：先抽取用户提示词中的章节/主题；若未明确章节，再使用通用结构兜底。`,
        `Split into ${pageCount} slides and generate page by page: first extract sections/topics from the user prompt; use generic fallback only when sections are missing.`,
      ),
    ].join("\n");
  }

  private extractPptPageCountFromPrompt(prompt: string): number {
    const text = (prompt || "").replace(/\s+/g, " ");
    const patterns: RegExp[] = [
      /(?:共|总计|总共|需要|生成|做|制作)\s*(\d{1,2})\s*页/i,
      /(\d{1,2})\s*页(?:\s*(?:ppt|幻灯|课件|演示文稿|投影片|简报))?/i,
      /(?:slides?|pages?)\s*[:：]?\s*(\d{1,2})/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (!m) continue;
      const value = Number.parseInt(m[1], 10);
      if (Number.isFinite(value) && value >= 1 && value <= 30) {
        return value;
      }
    }
    return 8;
  }

  private extractPreferredAspectRatioFromPrompt(prompt: string): string {
    const text = prompt || "";
    const match = text.match(/\b(1:1|16:9|9:16|4:3|3:4)\b/i);
    if (match?.[1]) return match[1];
    return (
      this.aspectRatioSelect?.value ||
      this.plugin.settings.defaultAspectRatio ||
      "16:9"
    );
  }

  private buildStrictImg2ImgPrompt(userPrompt: string): string {
    const withoutRefLine = this.composePromptWithReferenceLine(
      userPrompt,
      null,
    );
    const cleaned = withoutRefLine.replace(
      /\bimage[_-]?\d+\.(png|jpe?g|webp|gif|bmp)\b/gi,
      this.tr("上传参考图", "uploaded reference image"),
    );
    const guard = [
      this.tr("【图生图强约束】", "[Image-to-Image Hard Constraints]"),
      this.tr(
        '你只能以"本次上传的参考图"作为唯一视觉参考来源。',
        'Use the "uploaded reference image in this task" as the only visual reference source.',
      ),
      this.tr(
        "忽略提示词中提到的其他图片文件名、历史图片或外部图片描述。",
        "Ignore any other image filenames, historical images, or external image descriptions in the prompt.",
      ),
      this.tr(
        "必须严格保留上传参考图的主体身份、构图关系与关键视觉特征，再按用户要求做风格/细节变化。",
        "Strictly preserve identity, composition, and key visual features from the uploaded reference before applying style/detail changes.",
      ),
      this.tr(
        "不要替换为其他人物或其他参考来源。",
        "Do not replace with other people or reference sources.",
      ),
    ].join("\n");
    return `${guard}\n\n${this.tr("用户需求：", "User request:")}\n${cleaned}`;
  }

  private buildPptAutoGenerationTasks(
    prompt: string,
    context: NotesSelectionContext | null,
    pageCount: number,
    perPageCandidates: number,
    inputImages: SidebarInputImage[] = [],
  ): GenerationQueueTask[] {
    const safePageCount = Math.min(30, Math.max(1, pageCount));
    const safePerPage = Math.min(9, Math.max(1, perPageCandidates));
    const totalTasks = safePageCount * safePerPage;
    const fallbackPages: string[] = Array.from(
      { length: safePageCount },
      (_, i) => this.getFallbackPptPageTitle(i),
    );
    const rawBasePrompt = prompt
      .split("\n")
      .filter(
        (line) =>
          !line.includes(this.pptAutoMarker) &&
          !line.includes(this.pptAutoLegacyMarker),
      )
      .join("\n")
      .trim();
    const basePrompt = this.compactPptPromptForTaskCount(
      rawBasePrompt,
      totalTasks,
    );
    const pages = this.extractPptPageTitlesFromPrompt(
      basePrompt,
      fallbackPages,
      safePageCount,
    );
    const tasks: GenerationQueueTask[] = [];

    pages.forEach((pageTitle, pageIndex) => {
      for (let variant = 1; variant <= safePerPage; variant++) {
        const pagePrompt = [
          basePrompt,
          "",
          this.tr("【当前仅生成这一页】", "[Generate This Page Only]"),
          `${this.tr("页码", "Page")}: ${pageIndex + 1}/${pages.length}`,
          `${this.tr("页面标题", "Slide title")}: ${pageTitle}`,
          this.tr(
            "仅输出这一页的完整 PPT 画面，不要输出多页拼接图。",
            "Output only this single complete slide, not a multi-page collage.",
          ),
          `${this.tr("同页候选", "Variant")}: ${variant}/${safePerPage}`,
          this.tr(
            "同页候选之间可做版式/构图/插图细节差异，但保持主题和风格一致。",
            "Variants can differ in layout/composition/illustration details while keeping theme and style consistent.",
          ),
        ].join("\n");
        tasks.push({
          prompt: pagePrompt,
          context,
          sequence: tasks.length + 1,
          inputImages: [...inputImages],
        });
      }
    });

    return tasks;
  }

  private compactPptPromptForTaskCount(
    prompt: string,
    totalTasks: number,
  ): string {
    const trimmed = (prompt || "").trim();
    if (!trimmed) return trimmed;

    const maxChars =
      totalTasks > 120
        ? 1800
        : totalTasks > 64
          ? 2400
          : totalTasks > 24
            ? 3200
            : 4600;
    if (trimmed.length <= maxChars) return trimmed;

    const keepHead = Math.floor(maxChars * 0.78);
    const keepTail = Math.max(180, maxChars - keepHead);
    return `${trimmed.slice(0, keepHead).trim()}\n...\n${trimmed
      .slice(Math.max(0, trimmed.length - keepTail))
      .trim()}`;
  }

  private extractPptPageTitlesFromPrompt(
    prompt: string,
    fallbackPages: string[],
    pageCount: number,
  ): string[] {
    const lines = (prompt || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => Boolean(line));
    const found: string[] = [];
    const seen = new Set<string>();

    const explicitPatterns: RegExp[] = [
      /^(?:[-*]\s*)?第\s*(\d{1,2})\s*页\s*[:：\-\s]+(.+)$/i,
      /^(?:[-*]\s*)?(?:页|page|slide)\s*(\d{1,2})\s*[:：\-\s]+(.+)$/i,
    ];

    for (const line of lines) {
      let m: RegExpMatchArray | null = null;
      for (const pattern of explicitPatterns) {
        m = line.match(pattern);
        if (m) break;
      }
      if (!m) continue;
      const rawTitle = (m[2] || "").trim();
      const title = rawTitle
        .replace(/^["'""'']+|["'""'']+$/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!title) continue;
      if (title.length > 80) continue;
      if (
        /^(ppt|slide|页面|页码|标题|全局风格|内容来源|页级|通用质量)/i.test(
          title,
        )
      ) {
        continue;
      }
      if (seen.has(title)) continue;
      seen.add(title);
      found.push(title);
      if (found.length >= pageCount) break;
    }

    if (found.length >= Math.min(4, pageCount)) {
      while (found.length < pageCount) {
        found.push(fallbackPages[found.length]);
      }
      return found.slice(0, pageCount);
    }
    return fallbackPages.slice(0, pageCount);
  }

  private getFallbackPptPageTitle(index: number): string {
    const defaults = [
      this.tr("封面", "Cover"),
      this.tr("这篇内容在讲什么", "What This Content Is About"),
      this.tr("核心概念拆解", "Core Concepts"),
      this.tr("流程图与主线", "Flow and Main Path"),
      this.tr("场景与命令对照", "Scenario-to-Command Mapping"),
      this.tr("关键对比", "Key Comparison"),
      this.tr("实操步骤", "Practical Steps"),
      this.tr("总结与行动", "Summary and Action"),
    ];
    if (index < defaults.length) return defaults[index];
    return this.tr(`扩展内容 ${index + 1}`, `Extended Topic ${index + 1}`);
  }

  private async handleRegenerateCandidate(candidateId: string): Promise<void> {
    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) return;

    const candidateIndex = this.candidateManager.imageCandidates.findIndex(
      (c) => c.taskId === candidateId,
    );
    if (candidateIndex < 0) return;
    const candidate = this.candidateManager.imageCandidates[candidateIndex];
    if (candidate.status === "discarded") return;
    if (!(candidate.status === "ready" || candidate.status === "inserted")) {
      new Notice(
        this.tr(
          "请等待图片生成完成后再重生",
          "Please wait until image generation completes",
        ),
      );
      return;
    }

    const shouldDeleteSource = candidate.status !== "inserted";
    const oldFilePath = candidate.filePath;

    let sessionId: number;
    let sequence: number;
    if (this.generationQueue.pendingTaskCount > 0) {
      sessionId = this.generationQueue.currentSessionId;
      sequence = Math.max(1, this.generationQueue.activeRequestTotal + 1);
      this.generationQueue.activeRequestTotal += 1;
    } else {
      this.generationQueue.currentSessionId += 1;
      sessionId = this.generationQueue.currentSessionId;
      sequence = 1;
      this.generationQueue.activeRequestTotal = 1;
    }

    this.generationQueue.pendingTaskCount += 1;
    this.generationQueue.activeConcurrencyCount += 1;
    this.candidateManager.imageCandidates[candidateIndex] = {
      ...candidate,
      taskId: `pending-${sessionId}-${sequence}`,
      fileName: this.tr("生成中...", "Generating..."),
      filePath: "",
      createdAt: Date.now(),
      imageDataUrl: "",
      status: "pending",
      sessionId,
      sequence,
    };
    this.candidateManager.renderCandidateList();
    this.updateGenerateButtonState();

    if (shouldDeleteSource && oldFilePath) {
      await notesHandler
        .removeCandidateImageFile(oldFilePath)
        .catch(() => undefined);
    }

    void this.generationQueue
      .runOneGeneration(
        sessionId,
        candidate.sourcePrompt,
        candidate.sourceContext as NotesSelectionContext | null,
        sequence,
        candidate.sourceInputImages,
      )
      .finally(() => {
        this.generationQueue.activeConcurrencyCount = Math.max(
          0,
          this.generationQueue.activeConcurrencyCount - 1,
        );
        this.updateGenerateButtonState();
      });
    new Notice(this.tr("已开始重生该图片", "Regeneration started"));
  }
}
