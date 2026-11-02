(() => {
  const $ = (selector) => document.querySelector(selector);
  const welcome = $("#welcome");
  const editor = $("#editor");
  const fileInput = $("#file-input");
  const uploadStatus = $("#upload-status");
  const stageStatus = $("#stage-status");
  const dropZone = $("#drop-zone");
  const pageWrap = $("#page-wrap");
  const canvas = $("#pdf-canvas");
  const annotationsLayer = $("#annotations-layer");
  const interactionLayer = $("#interaction-layer");
  const pageStage = $("#page-stage");
  const downloadButton = $("#download-button");
  const textOptions = $("#text-options");
  const toolHint = $("#tool-hint");
  const toolTip = $("#tool-tip p");
  const editList = $("#edit-list");
  const fontFamilies = {
    Helvetica: 'Arial, Helvetica, sans-serif',
    TimesRoman: '"Times New Roman", Georgia, serif',
    Courier: '"Courier New", Courier, monospace',
  };
  let pageWidthPoints = 612;
  let pageHeightPoints = 792;

  let pdfDocument = null;
  let originalBytes = null;
  let fileName = "document.pdf";
  let pageNumber = 1;
  let zoom = 1;
  let renderScale = 1;
  let renderTask = null;
  let renderSequence = 0;
  let mode = "select";
  let edits = [];
  let nextEditId = 1;
  let dragStart = null;
  let draftElement = null;
  const pageTextCache = new Map();

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  function setStatus(element, message) {
    element.textContent = message;
  }

  function setMode(nextMode) {
    mode = nextMode;
    const buttons = {
      select: $("#select-tool"),
      text: $("#text-tool"),
      whiteout: $("#whiteout-tool"),
    };
    Object.entries(buttons).forEach(([name, button]) => {
      const active = name === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    interactionLayer.dataset.mode = mode;
    textOptions.hidden = mode !== "text";
    if (mode === "text") {
      toolHint.textContent = "Type your text, then click where you want it on the page.";
      toolTip.textContent = "Text is added on top of the original page. Download a copy when you're ready.";
      $("#text-value").focus();
    } else if (mode === "whiteout") {
      toolHint.textContent = "Drag over content to cover it visually. This is not secure redaction.";
      toolTip.textContent = "The original PDF content remains under the white cover and may still be recovered.";
    } else {
      toolHint.textContent = "Choose a tool, then click or drag on the page.";
      toolTip.textContent = "Edits are placed on top of the original page. Download a copy when you're ready.";
    }
  }

  function updatePageControls() {
    $("#current-page").textContent = String(pageNumber);
    $("#page-count").textContent = String(pdfDocument?.numPages || 1);
    $("#previous-page").disabled = pageNumber <= 1;
    $("#next-page").disabled = !pdfDocument || pageNumber >= pdfDocument.numPages;
    $("#zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  }

  function showEditor() {
    welcome.hidden = true;
    editor.hidden = false;
    downloadButton.disabled = false;
  }

  async function loadFile(file) {
    setStatus(uploadStatus, "");
    if (!file || (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf"))) {
      setStatus(uploadStatus, "Please choose a PDF file.");
      return;
    }
    if (!window.pdfjsLib || !window.PDFLib) {
      setStatus(uploadStatus, "The PDF tools could not load. Check your internet connection and refresh.");
      return;
    }

    setStatus(uploadStatus, "Opening your PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loadedDocument = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      if (pdfDocument) {
        await pdfDocument.destroy();
      }
      pdfDocument = loadedDocument;
      originalBytes = bytes;
      fileName = file.name;
      pageNumber = 1;
      zoom = 1;
      edits = [];
      nextEditId = 1;
      pageTextCache.clear();
      $("#file-name").textContent = fileName;
      pageWrap.hidden = false;
      setStatus(stageStatus, "");
      showEditor();
      updatePageControls();
      renderEditList();
      await renderPage();
    } catch (error) {
      console.error("Could not open PDF:", error);
      setStatus(uploadStatus, "This PDF could not be opened. It may be damaged or password-protected.");
    }
    fileInput.value = "";
  }

  function getCurrentEdits() {
    return edits.filter((edit) => edit.page === pageNumber);
  }

  function renderAnnotations() {
    annotationsLayer.replaceChildren();
    const pageWidth = pageWrap.clientWidth;
    const pageHeight = pageWrap.clientHeight;
    getCurrentEdits().forEach((edit) => {
      const element = document.createElement("div");
      if (edit.type === "text") {
        element.className = "text-annotation";
        element.textContent = edit.text;
        element.style.left = `${edit.x * pageWidth}px`;
        element.style.top = `${edit.y * pageHeight}px`;
        element.style.fontSize = `${edit.fontSize * renderScale}px`;
        element.style.color = edit.color;
        element.style.fontFamily = fontFamilies[edit.fontFamily];
        element.style.fontWeight = edit.bold ? "700" : "400";
        element.style.fontStyle = edit.italic ? "italic" : "normal";
      } else {
        element.className = "whiteout-annotation";
        element.style.left = `${edit.x * pageWidth}px`;
        element.style.top = `${edit.y * pageHeight}px`;
        element.style.width = `${edit.width * pageWidth}px`;
        element.style.height = `${edit.height * pageHeight}px`;
      }
      annotationsLayer.append(element);
    });
  }

  function renderRulers() {
    const rulerTop = $("#ruler-top");
    const rulerLeft = $("#ruler-left");
    const width = pageWidthPoints * renderScale;
    const height = pageHeightPoints * renderScale;
    const tickSpacing = 10 * renderScale;
    rulerTop.style.width = `${width}px`;
    rulerTop.style.setProperty("--ruler-step", `${tickSpacing}px`);
    rulerLeft.style.height = `${height}px`;
    rulerLeft.style.setProperty("--ruler-step", `${tickSpacing}px`);
    rulerTop.replaceChildren();
    rulerLeft.replaceChildren();

    for (let point = 0; point <= pageWidthPoints; point += 50) {
      const label = document.createElement("span");
      label.className = "ruler-label";
      label.textContent = String(point);
      label.style.left = `${point * renderScale}px`;
      rulerTop.append(label);
    }
    for (let point = 0; point <= pageHeightPoints; point += 50) {
      const label = document.createElement("span");
      label.className = "ruler-label";
      label.textContent = String(point);
      label.style.top = `${point * renderScale}px`;
      rulerLeft.append(label);
    }
    $("#text-x").max = String(Math.floor(pageWidthPoints));
    $("#text-y").max = String(Math.floor(pageHeightPoints));
  }

  async function renderPage() {
    if (!pdfDocument) return;
    const sequence = ++renderSequence;
    if (renderTask) {
      renderTask.cancel();
      renderTask = null;
    }
    setStatus(stageStatus, "Rendering page…");
    try {
      const page = await pdfDocument.getPage(pageNumber);
      if (sequence !== renderSequence) return;
      const baseViewport = page.getViewport({ scale: 1 });
      pageWidthPoints = baseViewport.width;
      pageHeightPoints = baseViewport.height;
      const availableWidth = Math.max(240, pageStage.clientWidth - 72);
      renderScale = Math.min(1.6, availableWidth / baseViewport.width) * zoom;
      const viewport = page.getViewport({ scale: renderScale });
      const pixelRatio = window.devicePixelRatio || 1;
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageWrap.style.width = `${viewport.width}px`;
      pageWrap.style.height = `${viewport.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      renderTask = page.render({ canvasContext: context, viewport });
      await renderTask.promise;
      if (sequence !== renderSequence) return;
      renderTask = null;
      renderRulers();
      renderAnnotations();
      setStatus(stageStatus, "");
      updatePageControls();
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      console.error("Could not render PDF page:", error);
      setStatus(stageStatus, "This page could not be displayed.");
    }
  }

  function renderEditList() {
    editList.replaceChildren();
    edits.forEach((edit) => {
      const item = document.createElement("li");
      item.className = "edit-item";
      const label = document.createElement("span");
      const description = edit.type === "text"
        ? `Text · ${edit.text || "Untitled"}`
        : "Whiteout";
      label.textContent = description;
      const pageLabel = document.createElement("small");
      pageLabel.textContent = `p. ${edit.page}`;
      const removeButton = document.createElement("button");
      removeButton.className = "delete-edit";
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `Remove ${description} on page ${edit.page}`);
      removeButton.addEventListener("click", () => {
        edits = edits.filter((candidate) => candidate.id !== edit.id);
        renderEditList();
        renderAnnotations();
      });
      item.append(label, pageLabel, removeButton);
      editList.append(item);
    });
    $("#edit-count").textContent = String(edits.length);
    $("#empty-edits").hidden = edits.length > 0;
  }

  function normalizedPosition(event) {
    const bounds = pageWrap.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  async function getPageText(page) {
    if (!pageTextCache.has(page.pageNumber)) {
      const textContent = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const items = textContent.items
        .filter((item) => "str" in item && item.str.trim() && item.transform)
        .map((item) => {
          const transform = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
          const xLength = Math.hypot(transform[0], transform[1]) || 1;
          const yLength = Math.hypot(transform[2], transform[3]) || 1;
          const textWidth = item.width * viewport.scale;
          const textHeight = (item.height || yLength) * viewport.scale;
          const xEnd = transform[4] + (transform[0] / xLength) * textWidth;
          const yEnd = transform[5] + (transform[1] / xLength) * textWidth;
          const topX = transform[4] + (transform[2] / yLength) * textHeight;
          const topY = transform[5] + (transform[3] / yLength) * textHeight;
          const fontStyle = textContent.styles[item.fontName];
          return {
            text: item.str,
            fontName: fontStyle?.fontFamily || item.fontName,
            isSerif: fontStyle?.isSerif || false,
            isMonospace: fontStyle?.isMonospace || false,
            left: Math.min(transform[4], xEnd, topX, topX + xEnd - transform[4]),
            right: Math.max(transform[4], xEnd, topX, topX + xEnd - transform[4]),
            top: Math.min(transform[5], yEnd, topY, topY + yEnd - transform[5]),
            bottom: Math.max(transform[5], yEnd, topY, topY + yEnd - transform[5]),
          };
        });
      pageTextCache.set(page.pageNumber, { items, viewport });
    }
    return pageTextCache.get(page.pageNumber);
  }

  function similarFont(font) {
    const name = font.fontName.toLowerCase();
    if (font.isMonospace || /mono|courier|typewriter|console/.test(name)) return "Courier";
    if (/sans|helvetica|arial|gothic/.test(name)) return "Helvetica";
    if (font.isSerif || /serif|times|georgia|cambria|garamond|book|roman|palatino/.test(name)) {
      return "TimesRoman";
    }
    return "Helvetica";
  }

  async function matchFontAtPosition(x, y) {
    const status = $("#font-match-status");
    if (!pdfDocument || !Number.isFinite(x) || !Number.isFinite(y)) {
      status.textContent = "Enter a valid X and Y position first.";
      return false;
    }
    if (x < 0 || y < 0 || x > pageWidthPoints || y > pageHeightPoints) {
      status.textContent = "The font search position must be within the page.";
      return false;
    }

    status.textContent = "Looking for nearby PDF text…";
    try {
      const page = await pdfDocument.getPage(pageNumber);
      const { items, viewport } = await getPageText(page);
      const screenPoint = viewport.convertToViewportPoint(x, viewport.height - y);
      const candidates = items.map((item) => {
        const dx = Math.max(item.left - screenPoint[0], 0, screenPoint[0] - item.right);
        const dy = Math.max(item.top - screenPoint[1], 0, screenPoint[1] - item.bottom);
        return { item, distance: Math.hypot(dx, dy), contains: dx === 0 && dy === 0 };
      });
      candidates.sort((a, b) => Number(b.contains) - Number(a.contains) || a.distance - b.distance);
      const match = candidates[0];
      if (!match || match.distance > 48 * viewport.scale) {
        status.textContent = items.length
          ? "No text font found within 48 pt. Try a position closer to the text."
          : "No selectable text found on this page. Scanned pages need OCR first.";
        return false;
      }

      const selectedFont = similarFont(match.item);
      $("#font-family").value = selectedFont;
      const selectedLabel = $("#font-family").selectedOptions[0].textContent;
      status.textContent = `Nearby PDF font style: "${match.item.fontName}". Closest available match selected: ${selectedLabel}.`;
      return true;
    } catch (error) {
      console.error("Could not inspect PDF fonts:", error);
      status.textContent = "Could not inspect fonts on this page.";
      return false;
    }
  }

  function addTextAtPosition(x, y) {
    const text = $("#text-value").value.trim();
    if (!text) {
      $("#text-value").focus();
      setStatus(stageStatus, "Type some text in Quick edits first.");
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > pageWidthPoints || y > pageHeightPoints) {
      setStatus(stageStatus, `Position must be within the page (0–${Math.floor(pageWidthPoints)} pt by 0–${Math.floor(pageHeightPoints)} pt).`);
      return;
    }
    setStatus(stageStatus, "");
    edits.push({
      id: nextEditId++,
      page: pageNumber,
      type: "text",
      text,
      fontSize: Number($("#font-size").value),
      fontFamily: $("#font-family").value,
      bold: $("#bold-toggle").getAttribute("aria-pressed") === "true",
      italic: $("#italic-toggle").getAttribute("aria-pressed") === "true",
      color: $("#text-color").value,
      x: x / pageWidthPoints,
      y: y / pageHeightPoints,
    });
    renderAnnotations();
    renderEditList();
  }

  interactionLayer.addEventListener("click", (event) => {
    if (mode !== "text" || !pdfDocument || dragStart) return;
    const position = normalizedPosition(event);
    const x = Math.round(position.x * pageWidthPoints * 10) / 10;
    const y = Math.round(position.y * pageHeightPoints * 10) / 10;
    $("#text-x").value = String(x);
    $("#text-y").value = String(y);
    matchFontAtPosition(x, y).then(() => addTextAtPosition(x, y));
  });

  interactionLayer.addEventListener("pointerdown", (event) => {
    if (mode !== "whiteout" || !pdfDocument) return;
    dragStart = normalizedPosition(event);
    interactionLayer.setPointerCapture(event.pointerId);
    draftElement = document.createElement("div");
    draftElement.className = "draft-whiteout";
    annotationsLayer.append(draftElement);
    event.preventDefault();
  });

  interactionLayer.addEventListener("pointermove", (event) => {
    if (!dragStart || !draftElement) return;
    const current = normalizedPosition(event);
    const left = Math.min(dragStart.x, current.x);
    const top = Math.min(dragStart.y, current.y);
    draftElement.style.left = `${left * pageWrap.clientWidth}px`;
    draftElement.style.top = `${top * pageWrap.clientHeight}px`;
    draftElement.style.width = `${Math.abs(current.x - dragStart.x) * pageWrap.clientWidth}px`;
    draftElement.style.height = `${Math.abs(current.y - dragStart.y) * pageWrap.clientHeight}px`;
  });

  interactionLayer.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const end = normalizedPosition(event);
    const left = Math.min(dragStart.x, end.x);
    const top = Math.min(dragStart.y, end.y);
    const width = Math.abs(end.x - dragStart.x);
    const height = Math.abs(end.y - dragStart.y);
    dragStart = null;
    draftElement = null;
    if (width * pageWrap.clientWidth < 8 || height * pageWrap.clientHeight < 8) {
      renderAnnotations();
      return;
    }
    edits.push({ id: nextEditId++, page: pageNumber, type: "whiteout", x: left, y: top, width, height });
    renderAnnotations();
    renderEditList();
  });

  async function downloadPdf() {
    if (!originalBytes || !window.PDFLib || downloadButton.disabled) return;
    downloadButton.disabled = true;
    const previousLabel = downloadButton.innerHTML;
    downloadButton.textContent = "Preparing…";
    setStatus(stageStatus, "Applying your edits…");
    try {
      const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
      const pdf = await PDFDocument.load(originalBytes);
      const pages = pdf.getPages();
      const embeddedFonts = new Map();
      for (const edit of edits) {
        if (edit.type !== "text") continue;
        const fontKey = `${edit.fontFamily}:${Boolean(edit.bold)}:${Boolean(edit.italic)}`;
        if (embeddedFonts.has(fontKey)) continue;
        const suffix = edit.bold && edit.italic
          ? edit.fontFamily === "TimesRoman" ? "BoldItalic" : "BoldOblique"
          : edit.bold
            ? "Bold"
            : edit.italic
              ? edit.fontFamily === "TimesRoman" ? "Italic" : "Oblique"
              : "";
        const standardFontName = `${edit.fontFamily}${suffix}`;
        const standardFont = StandardFonts[standardFontName];
        if (!standardFont) throw new Error(`Unsupported font: ${edit.fontFamily}`);
        embeddedFonts.set(fontKey, await pdf.embedFont(standardFont));
      }
      edits.forEach((edit) => {
        const page = pages[edit.page - 1];
        const { width, height } = page.getSize();
        if (edit.type === "text") {
          const color = edit.color.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
          const fontKey = `${edit.fontFamily}:${Boolean(edit.bold)}:${Boolean(edit.italic)}`;
          page.drawText(edit.text, {
            x: edit.x * width,
            y: height - edit.y * height - edit.fontSize,
            size: edit.fontSize,
            font: embeddedFonts.get(fontKey),
            color: rgb(color[0], color[1], color[2]),
          });
        } else {
          page.drawRectangle({
            x: edit.x * width,
            y: height - (edit.y + edit.height) * height,
            width: edit.width * width,
            height: edit.height * height,
            color: rgb(1, 1, 1),
            borderWidth: 0,
          });
        }
      });
      const bytes = await pdf.save();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName.replace(/\.pdf$/i, "")}-edited.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(stageStatus, "");
    } catch (error) {
      console.error("Could not save edited PDF:", error);
      setStatus(stageStatus, "Could not save this PDF. Try removing unsupported characters from added text.");
    } finally {
      downloadButton.disabled = false;
      downloadButton.innerHTML = previousLabel;
    }
  }

  $("#choose-file").addEventListener("click", () => fileInput.click());
  $("#replace-file").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
  downloadButton.addEventListener("click", downloadPdf);
  $("#select-tool").addEventListener("click", () => setMode("select"));
  $("#text-tool").addEventListener("click", () => setMode("text"));
  $("#whiteout-tool").addEventListener("click", () => setMode("whiteout"));
  $("#bold-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
  });
  $("#italic-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
  });
  $("#match-font").addEventListener("click", () => {
    if (!$("#text-x").value.trim() || !$("#text-y").value.trim()) {
      $("#font-match-status").textContent = "Enter both X and Y positions in points.";
      return;
    }
    matchFontAtPosition(Number($("#text-x").value), Number($("#text-y").value));
  });
  $("#place-text").addEventListener("click", () => {
    if (!$("#text-x").value.trim() || !$("#text-y").value.trim()) {
      setStatus(stageStatus, "Enter both X and Y positions in points.");
      return;
    }
    addTextAtPosition(Number($("#text-x").value), Number($("#text-y").value));
  });
  $("#previous-page").addEventListener("click", () => {
    if (pageNumber > 1) {
      pageNumber -= 1;
      updatePageControls();
      renderPage();
    }
  });
  $("#next-page").addEventListener("click", () => {
    if (pdfDocument && pageNumber < pdfDocument.numPages) {
      pageNumber += 1;
      updatePageControls();
      renderPage();
    }
  });
  $("#zoom-out").addEventListener("click", () => {
    zoom = Math.max(0.6, Math.round((zoom - 0.1) * 10) / 10);
    updatePageControls();
    renderPage();
  });
  $("#zoom-in").addEventListener("click", () => {
    zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10);
    updatePageControls();
    renderPage();
  });
  window.addEventListener("resize", () => {
    if (pdfDocument) renderPage();
  });

  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  }));
  dropZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));
})();
