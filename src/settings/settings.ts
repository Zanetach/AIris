/**
 * AIris Plugin Settings
 * 设置接口、类型和默认值
 */

// ========== API Provider Type ==========
export type ApiProvider = "openrouter" | "openai" | "gemini";

// ========== Quick Switch Model ==========
export interface QuickSwitchModel {
  provider: ApiProvider;
  modelId: string;
  displayName: string;
}

// ========== Prompt Preset ==========
export interface PromptPreset {
  id: string; // UUID
  name: string; // Display name
  prompt: string; // Prompt content
}

// ========== Plugin Settings Interface ==========
export interface CanvasAISettings {
  // API Provider selection
  apiProvider: ApiProvider;

  // OpenRouter settings
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterTextModel: string;
  openRouterImageModel: string;
  openRouterUseCustomTextModel: boolean;
  openRouterUseCustomImageModel: boolean;

  // OpenAI settings
  openAIApiKey: string;
  openAIBaseUrl: string;
  openAITextModel: string;
  openAIImageModel: string;
  openAIUseCustomTextModel: boolean;
  openAIUseCustomImageModel: boolean;

  // Google Gemini settings
  geminiApiKey: string;
  geminiBaseUrl: string;
  geminiTextModel: string;
  geminiImageModel: string;
  geminiUseCustomTextModel: boolean;
  geminiUseCustomImageModel: boolean;

  // Legacy fields (for migration)
  textModel?: string;
  imageModel?: string;
  useCustomTextModel?: boolean;
  useCustomImageModel?: boolean;

  // Image compression settings
  imageCompressionQuality: number; // WebP compression quality (0-100)
  imageMaxSize: number; // Max width/height for WebP output
  imageSaveFolder: string; // 生成图片保存目录（vault 内相对路径）

  // Image generation defaults (palette state)
  defaultAspectRatio: string;
  defaultResolution: string;
  defaultImageCount: number;
  sidebarDraftPrompt: string;
  sidebarSelectedPresetId: string;

  // Debug mode
  debugMode: boolean;
  showAllTextModelsInSettings: boolean;

  // System prompts
  imageSystemPrompt: string;

  // Prompt presets
  imagePresets: PromptPreset[];

  // Image generation timeout (seconds)
  imageGenerationTimeout: number;

  // Quick switch models
  quickSwitchImageModels: QuickSwitchModel[];
  paletteImageModel: string;

  // Multi-image generation
  maxParallelImageTasks: number; // 最大并行生图任务数
}

// ========== Default Settings ==========
export const DEFAULT_SETTINGS: CanvasAISettings = {
  apiProvider: "openrouter",

  openRouterApiKey: "",
  openRouterBaseUrl: "https://openrouter.ai",
  openRouterTextModel: "google/gemini-2.5-flash",
  openRouterImageModel: "google/gemini-3-pro-image-preview",
  openRouterUseCustomTextModel: false,
  openRouterUseCustomImageModel: false,

  openAIApiKey: "",
  openAIBaseUrl: "https://api.openai.com",
  openAITextModel: "gpt-4o-mini",
  openAIImageModel: "gpt-image-2",
  openAIUseCustomTextModel: false,
  openAIUseCustomImageModel: false,

  geminiApiKey: "",
  geminiBaseUrl: "https://generativelanguage.googleapis.com",
  geminiTextModel: "gemini-2.5-flash",
  geminiImageModel: "gemini-3-pro-image-preview",
  geminiUseCustomTextModel: false,
  geminiUseCustomImageModel: false,

  imageCompressionQuality: 80,
  imageMaxSize: 2048,
  imageSaveFolder: "",
  defaultAspectRatio: "1:1",
  defaultResolution: "1K",
  defaultImageCount: 4,
  sidebarDraftPrompt: "",
  sidebarSelectedPresetId: "",

  debugMode: false,
  showAllTextModelsInSettings: false,

  imageSystemPrompt:
    "Role: A Professional Image Creator. Use the following references for image creation.",

  imagePresets: [],

  imageGenerationTimeout: 120,

  quickSwitchImageModels: [],
  paletteImageModel: "",

  maxParallelImageTasks: 3,
};

// ========== Provider Utility Functions ==========

export function getModelByProvider(
  settings: CanvasAISettings,
  provider: ApiProvider,
  type: "text" | "image",
): string {
  const key = type === "text" ? "TextModel" : "ImageModel";
  switch (provider) {
    case "openrouter":
      return settings[`openRouter${key}`];
    case "openai":
      return settings[`openAI${key}`];
    case "gemini":
      return settings[`gemini${key}`];
    default:
      return "";
  }
}

export function setModelByProvider(
  settings: CanvasAISettings,
  provider: ApiProvider,
  type: "text" | "image",
  modelId: string,
): void {
  switch (provider) {
    case "openrouter":
      if (type === "text") settings.openRouterTextModel = modelId;
      else settings.openRouterImageModel = modelId;
      break;
    case "openai":
      if (type === "text") settings.openAITextModel = modelId;
      else settings.openAIImageModel = modelId;
      break;
    case "gemini":
      if (type === "text") settings.geminiTextModel = modelId;
      else settings.geminiImageModel = modelId;
      break;
  }
}
