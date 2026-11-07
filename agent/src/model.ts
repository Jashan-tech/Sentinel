import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export class ConfigError extends Error {}

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  maxRounds: number;
  maxOutputTokens: number;
  staleAfterMinutes: number;
  enableThinking: boolean;
}

export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const HARD_MAX_ROUNDS = 5;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(): AgentConfig {
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "NVIDIA_API_KEY is not set. Copy agent/.env.example to agent/.env and add a key from https://build.nvidia.com.",
    );
  }
  return {
    apiKey,
    model: process.env.NVIDIA_MODEL?.trim() || DEFAULT_MODEL,
    baseURL: process.env.NVIDIA_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1",
    maxRounds: Math.min(intEnv("MAX_INVESTIGATION_ROUNDS", HARD_MAX_ROUNDS), HARD_MAX_ROUNDS),
    maxOutputTokens: intEnv("MAX_OUTPUT_TOKENS", 2048),
    staleAfterMinutes: intEnv("STALE_AFTER_MINUTES", 15),
    enableThinking: process.env.NVIDIA_ENABLE_THINKING?.trim().toLowerCase() === "true",
  };
}

/**
 * There is no JS `@langchain/nvidia-ai-endpoints` package, so we use LangChain's OpenAI
 * adapter against NVIDIA's OpenAI-compatible endpoint (which supports `tools`).
 */
export function createModel(cfg: AgentConfig): BaseChatModel {
  return new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseURL },
    temperature: 0.2,
    maxTokens: cfg.maxOutputTokens,
    timeout: 90_000,
    maxRetries: 1,
    // Nemotron reasoning toggle. Off by default: reasoning tokens eat the output cap and are never shown.
    modelKwargs: { chat_template_kwargs: { enable_thinking: cfg.enableThinking } },
  });
}
