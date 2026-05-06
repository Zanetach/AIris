import { Notice } from "obsidian";
import type CanvasAIPlugin from "../../main";
import type { GeneratedImageCandidate } from "./note-image-task-manager";
import type { NotesSelectionContext } from "./notes-selection-handler";
import type {
  SidebarCandidateManager,
  SidebarImageCandidate,
  SidebarInputImage,
  FailedGenerationTask,
} from "./sidebar-candidate-manager";

export interface GenerationQueueTask {
  prompt: string;
  context: NotesSelectionContext | null;
  sequence: number;
  inputImages: SidebarInputImage[];
}

type ImageErrorCode =
  | "超时"
  | "余额不足"
  | "鉴权失败"
  | "网络异常"
  | "服务异常"
  | "未知错误";

export interface SidebarGenerationCallbacks {
  addMessage: (role: "user" | "assistant", content: string) => void;
  updateButtons: () => void;
}

export class SidebarGenerationQueue {
  public pendingTaskCount: number = 0;
  public activeRequestTotal: number = 0;
  public activeConcurrencyCount: number = 0;
  public currentSessionId: number = 0;
  public canceledSessionIds: Set<number> = new Set();

  private readonly plugin: CanvasAIPlugin;
  private readonly candidateManager: SidebarCandidateManager;
  private readonly tr: (zh: string, en: string) => string;
  private readonly callbacks: SidebarGenerationCallbacks;

  constructor(
    plugin: CanvasAIPlugin,
    candidateManager: SidebarCandidateManager,
    tr: (zh: string, en: string) => string,
    callbacks: SidebarGenerationCallbacks,
  ) {
    this.plugin = plugin;
    this.candidateManager = candidateManager;
    this.tr = tr;
    this.callbacks = callbacks;
  }

  public startGenerationBatch(
    prompt: string,
    context: NotesSelectionContext | null,
    requestCount: number,
    inputImages: SidebarInputImage[] = [],
  ): void {
    const tasks: GenerationQueueTask[] = Array.from(
      { length: requestCount },
      (_, i) => ({
        prompt,
        context,
        sequence: i + 1,
        inputImages: [...inputImages],
      }),
    );
    this.startGenerationTasks(tasks);
  }

  public startGenerationTasks(tasks: GenerationQueueTask[]): void {
    if (tasks.length === 0) return;
    this.currentSessionId += 1;
    const sessionId = this.currentSessionId;
    const sequencedTasks = tasks.map((task, index) => ({
      ...task,
      sequence: index + 1,
    }));

    this.activeRequestTotal = sequencedTasks.length;
    this.activeConcurrencyCount = 0;
    this.pendingTaskCount = sequencedTasks.length;
    this.prepareTaskPlaceholders(sessionId, sequencedTasks);
    this.callbacks.updateButtons();
    this.runGenerationQueue(sessionId, sequencedTasks);
  }

  public cancelCurrentGeneration(): void {
    if (this.pendingTaskCount <= 0) return;

    const notesHandler = this.plugin.getNotesHandler();
    notesHandler?.cancelImageTasks();

    const sessionId = this.currentSessionId;
    this.canceledSessionIds.add(sessionId);
    this.candidateManager.cancelPendingCandidates(sessionId);
    this.activeConcurrencyCount = 0;
    this.pendingTaskCount = 0;
    this.activeRequestTotal = 0;
    this.callbacks.updateButtons();
    new Notice(this.tr("已取消生成任务", "Generation cancelled"));
  }

  public retryFailedTasks(): void {
    if (
      this.pendingTaskCount > 0 ||
      this.candidateManager.failedTasks.length === 0
    )
      return;

    const tasksToRetry = [...this.candidateManager.failedTasks];
    this.candidateManager.failedTasks = [];

    const queueTasks: GenerationQueueTask[] = tasksToRetry.map(
      (task, index) => ({
        prompt: task.prompt,
        context: task.context as NotesSelectionContext | null,
        sequence: index + 1,
        inputImages: [...task.inputImages],
      }),
    );
    this.startGenerationTasks(queueTasks);
  }

  private prepareTaskPlaceholders(
    sessionId: number,
    tasks: GenerationQueueTask[],
  ): void {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const placeholders: SidebarImageCandidate[] = tasks.map((task, i) => ({
      taskId: `pending-${sessionId}-${task.sequence || i + 1}`,
      fileName: this.tr("生成中...", "Generating..."),
      filePath: "",
      notePath:
        (task.context as NotesSelectionContext | null)?.file?.path ||
        activeFile?.path ||
        "",
      createdAt: Date.now(),
      imageDataUrl: "",
      status: "pending" as const,
      sessionId,
      sequence: task.sequence || i + 1,
      sourcePrompt: task.prompt,
      sourceContext: task.context,
      sourceInputImages: [...task.inputImages],
    }));
    this.candidateManager.setPlaceholders(placeholders);
  }

  private runGenerationQueue(
    sessionId: number,
    tasks: GenerationQueueTask[],
  ): void {
    if (tasks.length === 0) return;
    const concurrency = this.getGenerationConcurrency(tasks.length);
    if (concurrency < tasks.length) {
      new Notice(
        this.tr(
          `检测到网络较慢，并发已自动降为 ${concurrency} 路以提高稳定性`,
          `Slow network detected. Concurrency auto-reduced to ${concurrency} for better stability.`,
        ),
      );
    }
    let cursor = 0;
    let running = 0;

    const pump = (): void => {
      if (this.isSessionCanceled(sessionId)) return;

      while (running < concurrency && cursor < tasks.length) {
        const task = tasks[cursor++];
        running += 1;
        this.activeConcurrencyCount += 1;
        this.callbacks.updateButtons();
        void this.runOneGeneration(
          sessionId,
          task.prompt,
          task.context,
          task.sequence,
          task.inputImages,
        ).finally(() => {
          running = Math.max(0, running - 1);
          this.activeConcurrencyCount = Math.max(
            0,
            this.activeConcurrencyCount - 1,
          );
          this.callbacks.updateButtons();
          pump();
        });
      }
    };

    pump();
  }

  public async runOneGeneration(
    sessionId: number,
    prompt: string,
    context: NotesSelectionContext | null,
    sequence: number,
    inputImages: SidebarInputImage[] = [],
  ): Promise<void> {
    const notesHandler = this.plugin.getNotesHandler();
    if (!notesHandler) {
      this.pendingTaskCount = Math.max(0, this.pendingTaskCount - 1);
      this.callbacks.updateButtons();
      return;
    }

    try {
      const maxAttempts = 1 + this.getRetryCountByNetwork();
      let candidate: GeneratedImageCandidate | null = null;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.isSessionCanceled(sessionId)) return;
        try {
          candidate = await notesHandler.handleImageGeneration(
            prompt,
            context,
            inputImages,
          );
          break;
        } catch (error) {
          lastError = error;
          const normalized = this.normalizeImageError(error);
          const canRetry =
            attempt < maxAttempts &&
            this.isRetryableErrorCode(normalized.code) &&
            !this.isSessionCanceled(sessionId);
          if (!canRetry) {
            break;
          }

          const delayMs = this.getRetryDelayMs(attempt);
          this.callbacks.addMessage(
            "assistant",
            this.tr(
              `第 ${sequence} 张生成失败，${Math.round(delayMs / 1000)} 秒后自动重试（${attempt + 1}/${maxAttempts}）`,
              `Image #${sequence} failed, retrying in ${Math.round(delayMs / 1000)}s (${attempt + 1}/${maxAttempts})`,
            ),
          );
          await this.sleepWithSessionCancel(delayMs, sessionId);
        }
      }

      if (!candidate) {
        throw lastError || new Error("generation_failed");
      }

      if (this.isSessionCanceled(sessionId)) {
        await notesHandler
          .removeCandidateImageFile(candidate.filePath)
          .catch(() => undefined);
        return;
      }

      this.candidateManager.resolvePendingCandidate(
        sessionId,
        sequence,
        candidate,
        prompt,
        context,
        inputImages,
      );
      this.callbacks.addMessage(
        "assistant",
        this.tr(
          "第 " + sequence + " 张图片已生成：" + candidate.fileName,
          `Image #${sequence} generated: ${candidate.fileName}`,
        ),
      );
    } catch (e) {
      if (!this.isSessionCanceled(sessionId)) {
        const msg = this.formatImageError(e);
        this.candidateManager.markPendingCandidateFailed(sessionId, sequence);
        this.callbacks.addMessage("assistant", msg);
        const failedTask: FailedGenerationTask = {
          id: "f-" + String(++this.candidateManager.failedTaskCounter),
          prompt,
          context,
          inputImages: [...inputImages],
          errorMessage: msg,
          createdAt: Date.now(),
        };
        this.candidateManager.addFailedTask(failedTask);
      }
    } finally {
      this.pendingTaskCount = Math.max(0, this.pendingTaskCount - 1);
      if (this.pendingTaskCount === 0) {
        const total = this.activeRequestTotal;
        this.activeRequestTotal = 0;
        this.activeConcurrencyCount = 0;
        const isCanceled = this.isSessionCanceled(sessionId);
        if (!isCanceled && total > 0) {
          const failedCount = this.candidateManager.failedTasks.length;
          const successCount = Math.max(0, total - failedCount);
          new Notice(
            this.tr(
              `已生成 ${successCount}/${total} 张，提示词已保留，可继续微调`,
              `Generated ${successCount}/${total}. Prompt has been kept for further tuning.`,
            ),
          );
        }
        this.canceledSessionIds.delete(sessionId);
      }
      this.callbacks.updateButtons();
    }
  }

  public isSessionCanceled(sessionId: number): boolean {
    return this.canceledSessionIds.has(sessionId);
  }

  private getGenerationConcurrency(taskCount: number): number {
    const requested = Math.min(9, Math.max(1, taskCount));
    const networkType = this.getEffectiveNetworkType();
    const online = navigator.onLine !== false;

    if (!online) return 1;
    if (networkType === "slow-2g") return Math.min(requested, 1);
    if (networkType === "2g") return Math.min(requested, 2);
    if (networkType === "3g") return Math.min(requested, 3);
    return requested;
  }

  private getEffectiveNetworkType():
    | "slow-2g"
    | "2g"
    | "3g"
    | "4g"
    | "unknown" {
    const connection = (
      navigator as Navigator & {
        connection?: { effectiveType?: string };
      }
    ).connection;
    const value = String(connection?.effectiveType || "").toLowerCase();
    if (
      value === "slow-2g" ||
      value === "2g" ||
      value === "3g" ||
      value === "4g"
    ) {
      return value;
    }
    return "unknown";
  }

  private getRetryCountByNetwork(): number {
    const networkType = this.getEffectiveNetworkType();
    if (navigator.onLine === false) return 0;
    if (networkType === "slow-2g" || networkType === "2g") return 3;
    if (networkType === "3g") return 2;
    return 1;
  }

  private getRetryDelayMs(retryIndex: number): number {
    const networkType = this.getEffectiveNetworkType();
    const base =
      networkType === "slow-2g" || networkType === "2g" ? 1800 : 1200;
    return Math.min(8000, base * 2 ** Math.max(0, retryIndex - 1));
  }

  private isRetryableErrorCode(code: ImageErrorCode): boolean {
    return code === "超时" || code === "网络异常" || code === "服务异常";
  }

  private sleepWithSessionCancel(ms: number, sessionId: number): Promise<void> {
    if (ms <= 0 || this.isSessionCanceled(sessionId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(), ms);
      if (this.isSessionCanceled(sessionId)) {
        window.clearTimeout(timer);
        resolve();
      }
    });
  }

  public normalizeImageError(rawError: unknown): {
    code: ImageErrorCode;
    message: string;
    suggestion: string;
  } {
    const source =
      rawError instanceof Error ? rawError.message : String(rawError || "");
    const text = source.toLowerCase();

    if (
      text.includes("timeout") ||
      text.includes("timed out") ||
      text.includes("超时")
    ) {
      return {
        code: "超时",
        message: this.tr(
          "请求超时，请稍后重试。",
          "Request timed out. Please try again later.",
        ),
        suggestion: this.tr(
          "可降低分辨率或切换更快的模型。",
          "Try lowering resolution or using a faster model.",
        ),
      };
    }

    if (
      text.includes("quota") ||
      text.includes("insufficient") ||
      text.includes("balance") ||
      text.includes("credit") ||
      text.includes("429") ||
      text.includes("余额")
    ) {
      return {
        code: "余额不足",
        message: this.tr(
          "账户额度或余额不足，无法继续生图。",
          "Insufficient account quota/balance. Unable to continue generation.",
        ),
        suggestion: this.tr(
          "请检查服务商余额、配额或账单状态。",
          "Please check provider balance, quota, or billing status.",
        ),
      };
    }

    if (
      text.includes("unauthorized") ||
      text.includes("forbidden") ||
      text.includes("api key") ||
      text.includes("auth") ||
      text.includes("401") ||
      text.includes("403") ||
      text.includes("密钥")
    ) {
      return {
        code: "鉴权失败",
        message: this.tr(
          "API 鉴权失败，请检查密钥配置。",
          "API authentication failed. Please check key settings.",
        ),
        suggestion: this.tr(
          "确认 API Key、生图模型和 Provider 配置。",
          "Confirm API key, image model, and provider configuration.",
        ),
      };
    }

    if (
      text.includes("network") ||
      text.includes("fetch") ||
      text.includes("econn") ||
      text.includes("socket") ||
      text.includes("dns") ||
      text.includes("连接")
    ) {
      return {
        code: "网络异常",
        message: this.tr(
          "网络连接异常，暂时无法访问生图服务。",
          "Network error. Unable to access image generation service.",
        ),
        suggestion: this.tr(
          "请检查网络、代理或稍后重试。",
          "Check network/proxy or retry later.",
        ),
      };
    }

    if (
      text.includes("500") ||
      text.includes("502") ||
      text.includes("503") ||
      text.includes("504") ||
      text.includes("bad gateway") ||
      text.includes("service unavailable") ||
      text.includes("invalid request") ||
      text.includes("provider")
    ) {
      return {
        code: "服务异常",
        message: this.tr(
          "生图服务返回异常，请稍后重试。",
          "Image service returned an error. Please retry later.",
        ),
        suggestion: this.tr(
          "可切换模型或 Provider 再试。",
          "Try switching model or provider.",
        ),
      };
    }

    return {
      code: "未知错误",
      message: this.tr(
        "发生未知错误，当前任务未完成。",
        "Unknown error. Current task did not complete.",
      ),
      suggestion: this.tr(
        "可先重试失败项，或切换模型后再试。",
        "Retry failed items first, or switch model and retry.",
      ),
    };
  }

  public formatImageError(rawError: unknown): string {
    const normalized = this.normalizeImageError(rawError);
    const codeLabel = this.tr(
      normalized.code,
      {
        超时: "TIMEOUT",
        余额不足: "INSUFFICIENT_BALANCE",
        鉴权失败: "AUTH_FAILED",
        网络异常: "NETWORK_ERROR",
        服务异常: "SERVICE_ERROR",
        未知错误: "UNKNOWN_ERROR",
      }[normalized.code] || "UNKNOWN_ERROR",
    );
    return (
      this.tr("错误码[", "Error[") +
      codeLabel +
      "] " +
      normalized.message +
      this.tr(" 建议：", " Suggestion: ") +
      normalized.suggestion
    );
  }
}
