/**
 * IProvider 接口
 * 所有 API Provider 必须实现此接口，ApiManager 通过此接口路由请求
 */

import type { CanvasAISettings } from "../settings/settings";
import type { GeminiContent } from "./types";

export interface IProvider {
  updateSettings(settings: CanvasAISettings): void;
  getApiKey(): string;

  chatCompletion(
    prompt: string,
    systemPrompt?: string,
    temperature?: number,
  ): Promise<string>;

  streamChatCompletion(
    prompt: string | GeminiContent[],
    systemPrompt?: string,
    temperature?: number,
    thinkingConfig?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
    },
  ): AsyncGenerator<
    { content?: string; thinking?: string; thoughtSignature?: string },
    void,
    unknown
  >;

  generateImage(
    instruction: string,
    imagesWithRoles: { base64: string; mimeType: string; role: string }[],
    contextText?: string,
    aspectRatio?: string,
    resolution?: string,
    abortSignal?: AbortSignal,
  ): Promise<string>;

  multimodalChat(
    prompt: string,
    mediaList: { base64: string; mimeType: string; type: "image" | "pdf" }[],
    systemPrompt?: string,
    temperature?: number,
    thinkingConfig?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
    },
  ): Promise<{ content: string; thinking?: string }>;
}
