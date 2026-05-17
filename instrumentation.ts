// Next.js auto-discovers `instrumentation.ts` at the project root and invokes
// `register()` once per server process. We only want the embedder warm-up to
// run on the Node.js runtime — the Edge runtime can't load onnxruntime-node.
export const register = async () => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  try {
    const { warmEmbedder } = await import("./lib/embeddings");
    // Fire-and-forget — don't block server start while the ~570 MB bge-m3 ONNX
    // file streams down on first boot.
    void (async () => {
      try {
        await warmEmbedder();
      } catch (error: unknown) {
        console.warn("warmEmbedder failed:", error);
      }
    })();
  } catch (error: unknown) {
    // lib/embeddings.ts not yet implemented (backend rewrite plan in flight).
    console.warn(
      "embedder module unavailable, skipping warm-up:",
      error instanceof Error ? error.message : error
    );
  }
};
