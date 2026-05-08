import { App, Notice, TFile } from "obsidian";
import type CanvasAIPlugin from "../../main";
import type { GeneratedImageCandidate } from "./note-image-task-manager";
import { ReferenceImagePreviewModal } from "./sidebar-modals";

export type CandidateStatus = "pending" | "ready" | "inserted" | "discarded";

export interface SidebarInputImage {
  base64: string;
  mimeType: string;
  role: "reference";
  fileName: string;
  sourcePath?: string;
}

export interface SidebarImageCandidate extends GeneratedImageCandidate {
  status: CandidateStatus;
  sessionId: number;
  sequence: number;
  sourcePrompt: string;
  sourceContext: unknown | null;
  sourceInputImages: SidebarInputImage[];
}

export interface FailedGenerationTask {
  id: string;
  prompt: string;
  context: unknown | null;
  inputImages: SidebarInputImage[];
  errorMessage: string;
  createdAt: number;
}

export interface SidebarCandidateCallbacks {
  updateButtons: () => void;
  getPendingTaskCount: () => number;
  onRegenerateCandidate: (candidateId: string) => Promise<void>;
}

export class SidebarCandidateManager {
  public imageCandidates: SidebarImageCandidate[] = [];
  public failedTasks: FailedGenerationTask[] = [];
  public failedTaskCounter: number = 0;
  public isBulkInserting: boolean = false;
  public discardedCandidateSlots: Set<string> = new Set();

  private candidateCleanupTimer: number | null = null;
  private readonly candidateTtlMs = 24 * 60 * 60 * 1000;
  private candidateRenderRaf: number | null = null;
  private candidateViewportKey: string = "";
  private readonly candidateGridMinWidth = 120;
  private readonly candidateGridGap = 8;
  private readonly candidateVirtualOverscanRows = 2;

  private readonly plugin: CanvasAIPlugin;
  private readonly app: App;
  private readonly candidateListEl: HTMLElement;
  private readonly messagesContainer: HTMLElement;
  private readonly tr: (zh: string, en: string) => string;
  private readonly callbacks: SidebarCandidateCallbacks;

  constructor(
    plugin: CanvasAIPlugin,
    candidateListEl: HTMLElement,
    messagesContainer: HTMLElement,
    tr: (zh: string, en: string) => string,
    callbacks: SidebarCandidateCallbacks,
  ) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.candidateListEl = candidateListEl;
    this.messagesContainer = messagesContainer;
    this.tr = tr;
    this.callbacks = callbacks;
  }

  public addMessage(role: "user" | "assistant", content: string): void {
    const wrapper = this.messagesContainer.createDiv(
      `sidebar-image-log-item ${role}`,
    );
    wrapper.createDiv({
      cls: `sidebar-image-log-message ${role}`,
      text: content,
    });
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  public getReadyCandidateCount(): number {
    return this.imageCandidates.filter((c) => c.status === "ready").length;
  }

  public setPlaceholders(candidates: SidebarImageCandidate[]): void {
    this.imageCandidates = candidates;
    this.renderCandidateList();
  }

  public cancelPendingCandidates(sessionId: number): void {
    this.imageCandidates = this.imageCandidates.filter(
      (c) => !(c.sessionId === sessionId && c.status === "pending"),
    );
    this.renderCandidateList();
  }

  public resolvePendingCandidate(
    sessionId: number,
    sequence: number,
    candidate: GeneratedImageCandidate,
    prompt: string,
    context: unknown | null,
    inputImages: SidebarInputImage[] = [],
  ): void {
    const slotKey = `${sessionId}:${sequence}`;
    if (this.discardedCandidateSlots.has(slotKey)) {
      const notesHandler = this.plugin.getNotesHandler();
      void notesHandler
        ?.removeCandidateImageFile(candidate.filePath)
        .catch(() => undefined);
      return;
    }

    const next: SidebarImageCandidate = {
      ...candidate,
      status: "ready",
      sessionId,
      sequence,
      sourcePrompt: prompt,
      sourceContext: context,
      sourceInputImages: [...inputImages],
    };

    const index = this.imageCandidates.findIndex(
      (c) => c.sessionId === sessionId && c.sequence === sequence,
    );
    if (index >= 0) {
      this.imageCandidates[index] = next;
    } else {
      this.imageCandidates.unshift(next);
    }
    this.renderCandidateList();
  }

  public markPendingCandidateFailed(sessionId: number, sequence: number): void {
    const index = this.imageCandidates.findIndex(
      (c) => c.sessionId === sessionId && c.sequence === sequence,
    );
    if (index < 0) return;
    this.imageCandidates.splice(index, 1);
    this.renderCandidateList();
  }

  public addFailedTask(task: FailedGenerationTask): void {
    this.failedTasks.push(task);
  }

  public getDiscardedCandidateSlots(): Set<string> {
    return this.discardedCandidateSlots;
  }

  public renderCandidateList(): void {
    this.renderCandidateListInternal(false);
  }

  public scheduleCandidateListRender(): void {
    if (this.candidateRenderRaf !== null) return;
    this.candidateRenderRaf = window.requestAnimationFrame(() => {
      this.candidateRenderRaf = null;
      this.renderCandidateListInternal(true);
    });
  }

  public startCandidateCleanupTimer(): void {
    if (this.candidateCleanupTimer !== null) return;
    this.candidateCleanupTimer = window.setInterval(
      () => {
        void this.clearExpiredCandidates();
      },
      10 * 60 * 1000,
    );
  }

  public stopCleanupTimer(): void {
    if (this.candidateCleanupTimer !== null) {
      window.clearInterval(this.candidateCleanupTimer);
      this.candidateCleanupTimer = null;
    }
  }

  public stopRenderRaf(): void {
    if (this.candidateRenderRaf !== null) {
      window.cancelAnimationFrame(this.candidateRenderRaf);
      this.candidateRenderRaf = null;
    }
  }

  private getCandidateLayoutMetrics(total: number): {
    columns: number;
    rowHeight: number;
    totalRows: number;
    viewportHeight: number;
    scrollTop: number;
  } {
    const width = Math.max(1, this.candidateListEl.clientWidth);
    const columns = Math.max(
      1,
      Math.floor(
        (width + this.candidateGridGap) /
          (this.candidateGridMinWidth + this.candidateGridGap),
      ),
    );
    const itemWidth =
      (width - (columns - 1) * this.candidateGridGap) / Math.max(1, columns);
    const rowHeight = Math.max(96, Math.ceil(itemWidth + 14));
    const totalRows = Math.max(1, Math.ceil(total / columns));
    const viewportHeight = Math.max(1, this.candidateListEl.clientHeight);
    const scrollTop = this.candidateListEl.scrollTop;
    return { columns, rowHeight, totalRows, viewportHeight, scrollTop };
  }

  private renderCandidateListInternal(fromScroll: boolean): void {
    if (this.imageCandidates.length === 0) {
      this.candidateViewportKey = "";
      this.candidateListEl.empty();
      this.candidateListEl.createDiv({
        cls: "sidebar-image-candidate-empty",
        text: this.tr("暂无图片", "No images yet"),
      });
      return;
    }

    const { columns, rowHeight, totalRows, viewportHeight, scrollTop } =
      this.getCandidateLayoutMetrics(this.imageCandidates.length);
    const startRow = Math.max(
      0,
      Math.floor(scrollTop / rowHeight) - this.candidateVirtualOverscanRows,
    );
    const endRow = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) +
        this.candidateVirtualOverscanRows,
    );
    const startIndex = startRow * columns;
    const endIndex = Math.min(this.imageCandidates.length, endRow * columns);
    const viewportKey = `${startIndex}-${endIndex}-${columns}-${this.imageCandidates.length}`;

    if (fromScroll && viewportKey === this.candidateViewportKey) {
      return;
    }
    this.candidateViewportKey = viewportKey;
    this.candidateListEl.empty();

    const topPad = Math.max(0, startRow * rowHeight);
    const bottomPad = Math.max(0, (totalRows - endRow) * rowHeight);
    if (topPad > 0) {
      const topSpacer = this.candidateListEl.createDiv(
        "sidebar-image-candidate-spacer",
      );
      topSpacer.style.height = `${topPad}px`;
    }

    this.imageCandidates
      .slice(startIndex, endIndex)
      .forEach((candidate) =>
        this.renderCandidateCard(this.candidateListEl, candidate),
      );

    if (bottomPad > 0) {
      const bottomSpacer = this.candidateListEl.createDiv(
        "sidebar-image-candidate-spacer",
      );
      bottomSpacer.style.height = `${bottomPad}px`;
    }
  }

  private renderCandidateCard(
    parent: HTMLElement,
    candidate: SidebarImageCandidate,
  ): void {
    const card = parent.createDiv("sidebar-image-candidate-card");
    const previewSrc = this.getCandidatePreviewSrc(candidate);
    const preview = card.createDiv("sidebar-image-candidate-preview");

    const statusText =
      candidate.status === "pending"
        ? this.tr("生成中", "Generating")
        : candidate.status === "ready"
          ? this.tr("待插入", "Ready")
          : this.tr("已插入", "Inserted");
    preview.createDiv({
      cls: `sidebar-image-candidate-status status-${candidate.status}`,
      text: statusText,
    });

    if (candidate.status === "pending") {
      preview.createDiv({ cls: "sidebar-candidate-progress-bar" });
    }

    const actions = preview.createDiv(
      "sidebar-image-candidate-actions-overlay",
    );
    const insertBtn = actions.createEl("button", {
      cls: "mod-cta candidate-btn-insert",
      text: this.tr("插入", "Insert"),
    });
    const regenerateBtn = actions.createEl("button", {
      cls: "candidate-btn-regenerate",
      text: this.tr("重生", "Regenerate"),
    });
    const discardBtn = actions.createEl("button", {
      cls: "candidate-btn-discard",
      text: this.tr("丢弃", "Discard"),
    });
    const copyPathBtn = actions.createEl("button", {
      cls: "candidate-btn-copy",
      text: this.tr("复制嵌入", "Copy Embed"),
    });

    if (previewSrc) {
      const img = preview.createEl("img", {
        attr: { src: previewSrc, alt: candidate.fileName },
      });
      img.loading = "lazy";
      preview.addClass("is-clickable");
      preview.setAttr(
        "title",
        this.tr(
          "悬停或点击显示操作；双击查看大图",
          "Hover/click to show actions; double-click to preview",
        ),
      );
      preview.addEventListener("click", () => {
        card.toggleClass("is-actions-visible", true);
      });
      preview.addEventListener("dblclick", () => {
        this.openCandidatePreviewModal(candidate, previewSrc);
      });
    } else {
      preview.createDiv({
        cls: "sidebar-image-candidate-preview-empty",
        text: this.tr("图片预览不可用", "Preview unavailable"),
      });
      card.addClass("is-actions-visible");
    }

    const canInsertSingle =
      candidate.status === "ready" && !this.isBulkInserting;
    const canOperateCompletedCandidate =
      (candidate.status === "ready" || candidate.status === "inserted") &&
      !this.isBulkInserting;
    const canCopyEmbed = canOperateCompletedCandidate && !!candidate.filePath;
    insertBtn.disabled = !canInsertSingle;
    regenerateBtn.disabled = !canOperateCompletedCandidate;
    discardBtn.disabled = !canOperateCompletedCandidate;
    copyPathBtn.disabled = !canCopyEmbed;

    const markVisible = (): void => card.addClass("is-actions-visible");
    [insertBtn, regenerateBtn, discardBtn, copyPathBtn].forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        markVisible();
      });
    });

    insertBtn.addEventListener("click", () => {
      void this.handleInsertCandidate(candidate.taskId);
    });
    regenerateBtn.addEventListener("click", () => {
      void this.callbacks.onRegenerateCandidate(candidate.taskId);
    });
    discardBtn.addEventListener("click", () => {
      void this.handleDiscardCandidate(candidate.taskId);
    });
    copyPathBtn.addEventListener("click", () => {
      void this.handleCopyCandidateEmbed(candidate.taskId);
    });
  }

  private openCandidatePreviewModal(
    candidate: SidebarImageCandidate,
    previewSrc: string,
  ): void {
    const modal = new ReferenceImagePreviewModal(
      this.app,
      previewSrc,
      candidate.fileName,
      {
        downloadText: this.tr("下载图片到本地", "Download Image"),
        insertText: this.tr("插入到笔记", "Insert into Note"),
        onDownload: () => this.downloadCandidateImage(candidate, previewSrc),
        onInsert: () => {
          void this.handleInsertCandidate(candidate.taskId);
        },
      },
    );
    modal.open();
  }

  private downloadCandidateImage(
    candidate: SidebarImageCandidate,
    previewSrc: string,
  ): void {
    try {
      const link = document.createElement("a");
      link.href = previewSrc;
      link.download = candidate.fileName || `ai-generated-${Date.now()}.png`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      new Notice(this.tr("已开始下载图片", "Image download started"));
    } catch (error) {
      console.error("Sidebar CoPilot: failed to download candidate image", error);
      new Notice(
        this.tr("下载失败，请重试", "Download failed. Please retry."),
      );
    }
  }

  public async handleInsertAllCandidates(): Promise<void> {
    if (this.callbacks.getPendingTaskCount() > 0 || this.isBulkInserting)
      return;

    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) return;

    const readyCandidates = this.imageCandidates.filter(
      (c) => c.status === "ready",
    );
    if (readyCandidates.length === 0) {
      new Notice(
        this.tr("没有可插入的图片", "No images available to insert"),
      );
      return;
    }

    this.isBulkInserting = true;
    this.callbacks.updateButtons();
    let success = 0;
    try {
      for (const candidate of readyCandidates) {
        const ok = await notesHandler.insertImageCandidate(candidate);
        if (ok) {
          candidate.status = "inserted";
          success += 1;
        }
      }
    } catch (error) {
      console.error("Sidebar CoPilot: bulk insert failed", error);
      new Notice(
        this.tr(
          "批量插入过程中出现错误，请重试",
          "An error occurred during bulk insert. Please retry.",
        ),
      );
    } finally {
      this.isBulkInserting = false;
      this.renderCandidateList();
      this.callbacks.updateButtons();
    }
    new Notice(
      this.tr(
        "已插入 " + success + " 张图片",
        `Inserted ${success} image(s)`,
      ),
    );
  }

  private async handleCopyCandidateEmbed(candidateId: string): Promise<void> {
    const candidate = this.imageCandidates.find(
      (c) => c.taskId === candidateId,
    );
    if (!candidate) return;
    if (!(candidate.status === "ready" || candidate.status === "inserted")) {
      new Notice(
        this.tr(
          "请等待图片生成完成后再复制",
          "Please wait until image generation completes",
        ),
      );
      return;
    }

    try {
      const normalized = (candidate.filePath || "").replace(/^\/+/, "");
      const embed = `![[${normalized}]]`;
      await navigator.clipboard.writeText(embed);
      new Notice(this.tr("已复制嵌入语法", "Copied embed syntax"));
    } catch {
      new Notice(
        this.tr(
          "复制失败，请检查系统剪贴板权限",
          "Copy failed. Please check clipboard permissions.",
        ),
      );
    }
  }

  public async handleInsertCandidate(candidateId: string): Promise<void> {
    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) return;

    const candidate = this.imageCandidates.find(
      (c) => c.taskId === candidateId,
    );
    if (!candidate) return;
    if (candidate.status !== "ready") {
      new Notice(
        this.tr(
          "当前候选图未就绪，无法插入。",
          "Candidate not ready and cannot be inserted.",
        ),
      );
      return;
    }

    const ok = await notesHandler.insertImageCandidate(candidate);
    if (!ok) return;

    candidate.status = "inserted";
    this.renderCandidateList();
    new Notice(
      this.tr(
        "图片已插入到当前笔记内容",
        "Image inserted into current note content",
      ),
    );
  }

  public async handleDiscardCandidate(candidateId: string): Promise<void> {
    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) return;

    const candidateIndex = this.imageCandidates.findIndex(
      (c) => c.taskId === candidateId,
    );
    if (candidateIndex < 0) return;
    const candidate = this.imageCandidates[candidateIndex];
    if (!(candidate.status === "ready" || candidate.status === "inserted")) {
      new Notice(
        this.tr(
          "请等待图片生成完成后再丢弃",
          "Please wait until image generation completes",
        ),
      );
      return;
    }

    const shouldDeleteSource = candidate.status !== "inserted";
    this.imageCandidates.splice(candidateIndex, 1);
    this.renderCandidateList();
    new Notice(this.tr("已丢弃该图片", "Discarded this image"));

    if (shouldDeleteSource) {
      try {
        await notesHandler.removeCandidateImageFile(candidate.filePath);
      } catch (e) {
        console.warn("Sidebar CoPilot: failed to delete discarded image", e);
      }
    }
  }

  private async clearExpiredCandidates(): Promise<void> {
    if (this.imageCandidates.length === 0) return;
    const notesHandler = this.plugin.getNotesHandler();
    const now = Date.now();

    const remaining: SidebarImageCandidate[] = [];
    for (const candidate of this.imageCandidates) {
      const expired = now - candidate.createdAt > this.candidateTtlMs;
      const keep = !expired || candidate.status === "inserted";
      if (keep) {
        remaining.push(candidate);
        continue;
      }

      if (candidate.status === "ready" && notesHandler) {
        try {
          await notesHandler.removeCandidateImageFile(candidate.filePath);
        } catch (e) {
          console.warn("Sidebar CoPilot: failed to cleanup expired image", e);
        }
      }
    }

    if (remaining.length !== this.imageCandidates.length) {
      this.imageCandidates = remaining;
      this.renderCandidateList();
    }
  }

  public getCandidatePreviewSrc(
    candidate: SidebarImageCandidate,
  ): string | null {
    if (candidate.imageDataUrl) {
      return candidate.imageDataUrl;
    }
    const filePath = candidate.filePath || "";
    if (!filePath) return null;
    try {
      const normalized = filePath.replace(/^\/+/, "");
      const fromAdapter = this.app.vault.adapter.getResourcePath(normalized);
      if (fromAdapter) {
        return fromAdapter;
      }
    } catch (error) {
      console.warn(
        "Sidebar CoPilot: failed to resolve preview via adapter",
        error,
      );
    }

    const abstract = this.app.vault.getAbstractFileByPath(filePath);
    if (!(abstract instanceof TFile)) {
      return null;
    }
    return this.app.vault.getResourcePath(abstract);
  }
}
