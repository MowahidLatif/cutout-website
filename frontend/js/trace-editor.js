/**
 * Manual cutout editor for the review modal. Attaches to `window.TraceEditor`.
 *
 *   const editor = TraceEditor.create(canvas, { onChange });
 *   await editor.load(imageUrl);   // same-origin or blob: URL
 *   editor.setTool("lasso" | "crop");
 *   editor.undo(); editor.reset(); editor.canUndo();
 *   const png = await editor.toBlob();
 *
 * Lasso: drag around what to keep; everything outside becomes transparent.
 * Crop box: drag a rectangle; the image is cut down to it. The exported PNG
 * is trimmed to its visible pixels (js/cutout-cleanup.js).
 * Each shape applies on top of the previous result. Works with mouse, pen
 * and touch (pointer events).
 *
 * Edits happen on a full-resolution offscreen canvas, capped at 16 MP —
 * iOS Safari refuses larger canvases — so very large images (e.g. PDF
 * renders) come out scaled down to that.
 */
(function () {
  const MAX_PIXELS = 16_000_000;
  const MIN_SHAPE_PX = 8; // shapes smaller than this (on screen) are ignored as stray taps

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image couldn't be loaded for editing."));
      img.src = src;
    });
  }

  function canvasOf(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }

  function create(canvas, { onChange } = {}) {
    const ctx = canvas.getContext("2d");
    let tool = "lasso";
    let source = null; // offscreen canvas: the image as loaded
    let history = []; // offscreen canvases, newest last
    let view = { scale: 1 }; // display px per image px
    let drag = null; // { points: [[x, y]…] } in display px

    const current = () => history[history.length - 1];
    const changed = () => onChange && onChange();

    /** Fits the canvas to its container (and the image's shape), then redraws. */
    function layout() {
      const img = current();
      if (!img) return;
      const wrap = canvas.parentElement;
      const maxW = wrap.clientWidth || 300;
      // Leave room for the toolbar and buttons, which stack on phones.
      const share = window.innerWidth < 720 ? 0.4 : 0.55;
      const maxH = Math.max(200, Math.min(window.innerHeight * share, 640));
      view.scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.max(1, Math.round(img.width * view.scale));
      const h = Math.max(1, Math.round(img.height * view.scale));
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      draw();
    }

    function draw() {
      const img = current();
      if (!img) return;
      const dpr = canvas.width / parseFloat(canvas.style.width);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (!drag || drag.points.length < 2) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#d9572b";
      ctx.fillStyle = "rgba(217, 87, 43, 0.12)";
      ctx.beginPath();
      if (tool === "crop") {
        const r = rectOf(drag.points);
        ctx.rect(r.x, r.y, r.w, r.h);
      } else {
        drag.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function rectOf(points) {
      const [x0, y0] = points[0];
      const [x1, y1] = points[points.length - 1];
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }

    function pointerPos(e) {
      const box = canvas.getBoundingClientRect();
      const w = parseFloat(canvas.style.width);
      const h = parseFloat(canvas.style.height);
      return [Math.min(w, Math.max(0, e.clientX - box.left)), Math.min(h, Math.max(0, e.clientY - box.top))];
    }

    /** Applies the dragged shape to the current image and pushes the result. */
    function apply(points) {
      const img = current();
      const s = 1 / view.scale; // display px → image px
      if (tool === "crop") {
        const r = rectOf(points);
        if (r.w < MIN_SHAPE_PX || r.h < MIN_SHAPE_PX) return;
        const x = Math.round(r.x * s);
        const y = Math.round(r.y * s);
        const w = Math.min(img.width - x, Math.round(r.w * s));
        const h = Math.min(img.height - y, Math.round(r.h * s));
        const out = canvasOf(w, h);
        out.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
        history.push(out);
      } else {
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        if (points.length < 3 || Math.max(...xs) - Math.min(...xs) < MIN_SHAPE_PX || Math.max(...ys) - Math.min(...ys) < MIN_SHAPE_PX) {
          return;
        }
        const out = canvasOf(img.width, img.height);
        const octx = out.getContext("2d");
        octx.beginPath();
        points.forEach(([px, py], i) => (i ? octx.lineTo(px * s, py * s) : octx.moveTo(px * s, py * s)));
        octx.closePath();
        octx.clip();
        octx.drawImage(img, 0, 0);
        history.push(out);
      }
      layout();
      changed();
    }

    canvas.style.touchAction = "none"; // drawing, not scrolling, while on the canvas
    canvas.addEventListener("pointerdown", (e) => {
      if (!current() || (e.pointerType === "mouse" && e.button !== 0)) return;
      canvas.setPointerCapture(e.pointerId);
      drag = { points: [pointerPos(e)] };
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = pointerPos(e);
      if (tool === "crop") {
        drag.points = [drag.points[0], p];
      } else {
        const [lx, ly] = drag.points[drag.points.length - 1];
        if (Math.hypot(p[0] - lx, p[1] - ly) >= 2) drag.points.push(p);
      }
      draw();
    });
    const finish = () => {
      if (!drag) return;
      const points = drag.points;
      drag = null;
      apply(points);
      draw();
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", () => {
      drag = null;
      draw();
    });

    return {
      async load(src) {
        const img = await loadImage(src);
        const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (img.naturalWidth * img.naturalHeight)));
        source = canvasOf(Math.round(img.naturalWidth * fit), Math.round(img.naturalHeight * fit));
        source.getContext("2d").drawImage(img, 0, 0, source.width, source.height);
        history = [source];
        layout();
        changed();
      },
      setTool(name) {
        tool = name === "crop" ? "crop" : "lasso";
      },
      undo() {
        if (history.length > 1) history.pop();
        layout();
        changed();
      },
      reset() {
        if (source) history = [source];
        layout();
        changed();
      },
      canUndo: () => history.length > 1,
      edited: () => history.length > 1,
      layout,
      toBlob() {
        return CutoutCleanup.toPngBlob(CutoutCleanup.trimToContent(current()));
      },
    };
  }

  window.TraceEditor = { create };
})();
