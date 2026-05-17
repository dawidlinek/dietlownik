/**
 * Shared candidate-model registry for the embedding bench.
 *
 * Extracted as a side-effect-free module so both `bench-embed-all.ts`
 * (executable: embeds the corpus per model) and `bench-rank.ts`
 * (executable: scores models against labels) can read the same list
 * without one running the other's top-level `await main()` on import.
 */

export interface Candidate {
  readonly id: string;
  readonly model: string;
  /** Prefix prepended to MEAL text before embedding. */
  readonly passagePrefix?: string;
  /** Prefix prepended to QUERY text at retrieval time (used by bench-rank). */
  readonly queryPrefix?: string;
  readonly quantized?: boolean;
}

// Models we have ONNX exports for via @xenova/transformers. Polish-specific
// models (mmlw, silver-retriever, snowflake-arctic) need their own ONNX
// export step before they can be added here — see bench/README.md.
//
// The e5 family was trained with an asymmetric convention: 'passage: ' for
// indexed documents, 'query: ' for searches. Bench-rank uses queryPrefix;
// bench-embed-all uses passagePrefix.
export const CANDIDATES: readonly Candidate[] = [
  { id: "bge-m3", model: "Xenova/bge-m3" },
  {
    id: "e5-small",
    model: "Xenova/multilingual-e5-small",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  {
    id: "e5-base",
    model: "Xenova/multilingual-e5-base",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  {
    id: "e5-large",
    model: "Xenova/multilingual-e5-large",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  { id: "minilm-multi", model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" },
  { id: "mpnet-multi", model: "Xenova/paraphrase-multilingual-mpnet-base-v2" },
  { id: "labse", model: "Xenova/LaBSE" },
];
