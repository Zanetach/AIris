/**
 * API Manager - 统一入口
 * 通过 IProvider 注册表路由请求，新增 Provider 只需注册一行
 */

import type { CanvasAISettings, ApiProvider } from "../settings/settings";
import type { IProvider } from "./i-provider";
import type { GeminiContent } from "./types";
import { OpenRouterProvider } from "./providers/openrouter";
import { GeminiProvider } from "./providers/gemini";
import { OpenAIProvider } from "./providers/openai";

// Re-export types for backward compatibility
export type {
  OpenRouterMessage,
  OpenRouterContentPart,
  OpenRouterImageConfig,
  OpenRouterRequest,
  OpenRouterChoice,
  OpenRouterResponse,
  GeminiPart,
  GeminiContent,
  GeminiRequest,
  GeminiCandidate,
  GeminiResponse,
} from "./types";

export class ApiManager {
  private settings: CanvasAISettings;
  private providers: Map<ApiProvider, IProvider>;

  constructor(settings: CanvasAISettings) {
    this.settings = settings;
    this.providers = new Map<ApiProvider, IProvider>([
      ["openrouter", new OpenRouterProvider(settings)],
      ["openai", new OpenAIProvider(settings)],
      ["gemini", new GeminiProvider(settings)],
    ]);
  }

  updateSettings(settings: CanvasAISettings): void {
    this.settings = settings;
    for (const provider of this.providers.values()) {
      provider.updateSettings(settings);
    }
  }

  private getActiveProvider(): IProvider {
    const id = this.settings.apiProvider;
    return this.providers.get(id) ?? this.providers.get("openrouter")!;
  }

  isConfigured(): boolean {
    return !!this.getActiveProvider().getApiKey();
  }

  async chatCompletion(
    prompt: string,
    systemPrompt?: string,
    temperature: number = 0.5,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "API Key not configured. Please set it in plugin settings.",
      );
    }
    return this.getActiveProvider().chatCompletion(
      prompt,
      systemPrompt,
      temperature,
    );
  }

  async *streamChatCompletion(
    prompt: string | GeminiContent[],
    systemPrompt?: string,
    temperature: number = 1.0,
    thinkingConfig?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
    },
  ): AsyncGenerator<
    { content?: string; thinking?: string; thoughtSignature?: string },
    void,
    unknown
  > {
    if (!this.isConfigured()) {
      throw new Error(
        "API Key not configured. Please set it in plugin settings.",
      );
    }
    yield* this.getActiveProvider().streamChatCompletion(
      prompt,
      systemPrompt,
      temperature,
      thinkingConfig,
    );
  }

  async generateImageWithRoles(
    instruction: string,
    imagesWithRoles: { base64: string; mimeType: string; role: string }[],
    contextText?: string,
    aspectRatio?: string,
    resolution?: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "API Key not configured. Please set it in plugin settings.",
      );
    }
    return this.getActiveProvider().generateImage(
      instruction,
      imagesWithRoles,
      contextText,
      aspectRatio,
      resolution,
      abortSignal,
    );
  }

  async multimodalChat(
    prompt: string,
    mediaList: { base64: string; mimeType: string; type: "image" | "pdf" }[],
    systemPrompt?: string,
    temperature: number = 1.0,
    thinkingConfig?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
    },
  ): Promise<{ content: string; thinking?: string }> {
    if (!this.isConfigured()) {
      throw new Error(
        "API Key not configured. Please set it in plugin settings.",
      );
    }
    return this.getActiveProvider().multimodalChat(
      prompt,
      mediaList,
      systemPrompt,
      temperature,
      thinkingConfig,
    );
  }
}
