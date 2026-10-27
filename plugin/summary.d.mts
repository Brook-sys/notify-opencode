/**
 * Tipos do núcleo puro do resumo (plugin/summary.mjs).
 * O runtime carrega o .mjs; este arquivo existe só para o editor/tsc.
 */

export type SummarySource = "llm" | "heuristic" | "fallback" | "none"

export type SummaryResult = {
  text: string
  source: SummarySource
  latencyMs: number
  inputChars: number
  outputChars: number
  error?: string
  errorName?: string
  errorStack?: string
}

export type SummaryConfig = {
  maxChars?: number
  minSourceChars?: number
  maxInputChars?: number
  language?: string
}

export type SummaryInput = {
  kind: "done" | "error" | "question" | "permission" | string
  source: string
  generate: (input: { prompt: string }) => Promise<{ text?: string } | string>
  config?: SummaryConfig
  timeoutMs?: number
  now?: () => number
}

export declare const SUMMARY_DEFAULTS: Required<SummaryConfig>

export declare function cleanText(input: unknown): string
export declare function truncateAtSentence(text: string, maxChars: number, prefer?: "start" | "end"): string
export declare function buildPrompt(kind: string, content: string, maxChars: number, language?: string): string
export declare function sanitizeOutput(text: unknown, maxChars: number): string
export declare function fallbackText(cleaned: string, kind: string, maxChars: number): string
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>
export declare function summarize(input: SummaryInput): Promise<SummaryResult>
