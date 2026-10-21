/**
 * In-browser background removal. Attaches to `window.BackgroundRemoval`.
 *
 * Runs entirely on the customer's device: the photo never leaves the
 * browser for this step. Only the library and the model are downloaded,
 * once, then cached by the browser.
 *
 *   Library: Transformers.js (@huggingface/transformers), Apache-2.0,
 *            loaded from jsDelivr, pinned version (SITE.backgroundRemoval).
 *   Model:   MODNet (Xenova/modnet), Apache-2.0, ~6.6 MB quantized, pinned
 *            revision. Strongest on people; pets/objects can come out rough,
 *            which is why customers can turn removal off per photo.
 *
 * Both licenses allow commercial use. (We deliberately avoid AGPL or
 * non-commercial models such as @imgly/background-removal, ISNet or RMBG.)
 */
(function () {
  // URLs and the pinned versions live in js/site-config.js.
  const { libraryUrl, model, modelRevision } = window.SITE.backgroundRemoval;

  let pipelinePromise = null;
  let queue = Promise.resolve(); // one photo at a time, so phones don't run out of memory

  /** Loads the library and model once; later calls reuse them. */
  function loadPipeline(onStatus) {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const transformers = await import(libraryUrl);
        transformers.env.allowLocalModels = false;
        // Single-threaded: works without cross-origin isolation and keeps
        // memory down on phones (MODNet is small, so it's still quick).
        transformers.env.backends.onnx.wasm.numThreads = 1;
        return transformers.pipeline("background-removal", model, {
          revision: modelRevision,
          device: "wasm",
          dtype: "uint8",
          progress_callback: (event) => {
            if (event.status === "progress" && event.total && onStatus) {
              onStatus({ phase: "downloading", percent: Math.round((event.loaded / event.total) * 100) });
            }
          },
        });
      })().catch((err) => {
        pipelinePromise = null; // let a later attempt retry the download
        throw err;
      });
    }
    return pipelinePromise;
  }

  /**
   * Removes the background from an image.
   *
   * @param {string} imageUrl any URL the page can fetch (same-origin or blob:)
   * @param {{ onStatus?: (s: { phase: "queued"|"downloading"|"processing", percent?: number }) => void }} [options]
   * @returns {Promise<Blob>} a PNG of the subject on a transparent background,
   *   with holes inside it filled and empty margins trimmed (js/cutout-cleanup.js)
   */
  function remove(imageUrl, { onStatus } = {}) {
    if (onStatus) onStatus({ phase: "queued" });
    const run = queue.then(async () => {
      const remover = await loadPipeline(onStatus);
      if (onStatus) onStatus({ phase: "processing" });
      const output = await remover(new URL(imageUrl, window.location.href).href);
      const image = Array.isArray(output) ? output[0] : output;
      if (image.channels !== 4) return image.toBlob("image/png");
      const rgba = new Uint8ClampedArray(image.data);
      CutoutCleanup.fillHoles(rgba, image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d").putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
      return CutoutCleanup.toPngBlob(CutoutCleanup.trimToContent(canvas));
    });
    queue = run.catch(() => {});
    return run;
  }

  window.BackgroundRemoval = {
    remove,
    isSupported: () => typeof WebAssembly === "object" && typeof Worker === "function",
  };
})();
