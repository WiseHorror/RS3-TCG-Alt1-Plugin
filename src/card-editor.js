const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Godly"];
const PAGE_SIZE = 100;
const NUMERIC_FIELDS = ["level", "value", "geValue", "highAlchValue", "experience", "overrideScore"];
const PREVIEW_FIELD_TARGETS = {
  id: ["#previewId"],
  name: ["#previewName"],
  rarity: ["#previewRarity"],
  examine: ["#previewExamine"],
  category: ["#previewType"],
  imageUrl: [".preview-art"],
  value: ["#previewValue"]
};

let cards = [];
let originalCards = [];
let filteredCards = [];
let selectedCard = null;
const checkedCardIds = new Set();
let page = 0;
let dirty = false;
let toastTimer = null;
let rarityConfig = {};
let lastCheckedCardId = null;

const qs = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));

function showToast(message) {
  const toast = qs("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3000);
}

function setDirty(value) {
  dirty = value;
  const status = qs("#dirtyStatus");
  status.textContent = dirty ? "Unsaved changes" : "Saved";
  status.classList.toggle("dirty", dirty);
}

function highlightPreviewField(fieldName = "") {
  document.querySelectorAll(".preview-edit-highlight").forEach((element) => element.classList.remove("preview-edit-highlight"));
  (PREVIEW_FIELD_TARGETS[fieldName] || []).forEach((selector) => qs(selector).classList.add("preview-edit-highlight"));
}

function cloneCards(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseCreditValue(rarity) {
  return Number(rarityConfig[rarity]?.baseCreditValue) || 0;
}

function populateFilters() {
  qs("#rarityFilter").innerHTML = '<option value="">All rarities</option>'
    + RARITIES.map((rarity) => `<option>${rarity}</option>`).join("");
  const types = [...new Set(cards.flatMap((card) => card.category || []))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  qs("#typeFilter").innerHTML = '<option value="">All types</option>'
    + types.map((type) => `<option>${escapeHtml(type)}</option>`).join("");
  const raritySelect = qs('[name="rarity"]');
  raritySelect.innerHTML = RARITIES.map((rarity) => `<option>${rarity}</option>`).join("");
}

function applyFilters(resetPage = true) {
  const search = qs("#searchInput").value.trim().toLowerCase();
  const rarity = qs("#rarityFilter").value;
  const type = qs("#typeFilter").value;
  const image = qs("#imageFilter").value;
  filteredCards = cards.filter((card) => {
    if (rarity && card.rarity !== rarity) return false;
    if (type && !(card.category || []).includes(type)) return false;
    if (image === "present" && !card.imageUrl) return false;
    if (image === "missing" && card.imageUrl) return false;
    if (!search) return true;
    return `${card.name} ${card.id} ${card.wikiTitle} ${(card.category || []).join(" ")} ${card.examine}`.toLowerCase().includes(search);
  });
  if (resetPage) page = 0;
  page = Math.min(page, Math.max(0, Math.ceil(filteredCards.length / PAGE_SIZE) - 1));
  renderList();
}

function renderList() {
  const list = qs("#cardList");
  const pageCards = filteredCards.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  list.innerHTML = pageCards.map((card) => {
    const selected = selectedCard && selectedCard.id === card.id;
    const checked = checkedCardIds.has(card.id);
    const image = card.imageUrl
      ? `<img src="${escapeHtml(card.imageUrl)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="row-fallback" hidden>${escapeHtml(card.name.slice(0, 1))}</span>`
      : `<span class="row-fallback">${escapeHtml(card.name.slice(0, 1))}</span>`;
    return `<div class="card-row ${escapeHtml(card.rarity.toLowerCase())}${selected ? " selected" : ""}" data-card-id="${escapeHtml(card.id)}" role="option" tabindex="0" aria-selected="${selected}">
      <input class="card-check" type="checkbox" aria-label="Select ${escapeHtml(card.name)}"${checked ? " checked" : ""}>
      ${image}<span class="row-copy"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml((card.category || []).join(" / "))}</small></span><span class="row-rarity">${escapeHtml(card.rarity)}</span>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-card-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (!event.target.classList.contains("card-check")) selectCard(row.dataset.cardId);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCard(row.dataset.cardId);
      }
    });
    row.querySelector(".card-check").addEventListener("click", (event) => {
      const cardId = row.dataset.cardId;
      let rangeApplied = false;
      if (event.shiftKey && lastCheckedCardId) {
        const start = filteredCards.findIndex((card) => card.id === lastCheckedCardId);
        const end = filteredCards.findIndex((card) => card.id === cardId);
        if (start !== -1 && end !== -1) {
          const [from, to] = start < end ? [start, end] : [end, start];
          filteredCards.slice(from, to + 1).forEach((card) => {
            if (event.target.checked) checkedCardIds.add(card.id);
            else checkedCardIds.delete(card.id);
          });
          rangeApplied = true;
          renderList();
        }
      }
      if (!rangeApplied) {
        if (event.target.checked) checkedCardIds.add(cardId);
        else checkedCardIds.delete(cardId);
      }
      lastCheckedCardId = cardId;
      updateDeleteButton();
      updateSelectAllCheckbox();
    });
  });
  const pageCount = Math.max(1, Math.ceil(filteredCards.length / PAGE_SIZE));
  qs("#resultCount").textContent = `${filteredCards.length.toLocaleString()} cards`;
  qs("#pageStatus").textContent = `Page ${page + 1} of ${pageCount}`;
  qs("#previousPage").disabled = page === 0;
  qs("#nextPage").disabled = page >= pageCount - 1;
  updateSelectAllCheckbox();
}

function updateSelectAllCheckbox() {
  const checkbox = qs("#selectAllCards");
  const selectedCount = filteredCards.reduce((count, card) => count + Number(checkedCardIds.has(card.id)), 0);
  checkbox.checked = filteredCards.length > 0 && selectedCount === filteredCards.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < filteredCards.length;
  checkbox.disabled = filteredCards.length === 0;
}

function updateDeleteButton() {
  const count = checkedCardIds.size;
  const button = qs("#deleteButton");
  button.disabled = count === 0 && !selectedCard;
  button.textContent = count ? `Delete selected (${count})` : "Delete card";
}

function selectCard(id) {
  selectedCard = cards.find((card) => card.id === id) || null;
  qs("#cardFields").disabled = !selectedCard;
  qs("#revertButton").disabled = !selectedCard;
  updateDeleteButton();
  if (selectedCard) fillForm(selectedCard);
  renderPreview();
  renderList();
}

function fillForm(card) {
  const form = qs("#cardForm");
  ["id", "name", "rarity", "examine", "imageUrl", "wikiTitle"].forEach((field) => { form.elements[field].value = card[field] ?? ""; });
  form.elements.category.value = (card.category || []).join(", ");
  form.elements.questItem.value = String(Boolean(card.questItem));
  NUMERIC_FIELDS.forEach((field) => { form.elements[field].value = card[field] ?? ""; });
  qs("#formTitle").textContent = card.name;
}

function updateSelectedCard() {
  if (!selectedCard) return;
  const form = qs("#cardForm");
  ["name", "rarity", "examine", "imageUrl", "wikiTitle"].forEach((field) => { selectedCard[field] = form.elements[field].value; });
  selectedCard.category = form.elements.category.value.split(",").map((value) => value.trim()).filter(Boolean);
  selectedCard.questItem = form.elements.questItem.value === "true";
  NUMERIC_FIELDS.forEach((field) => {
    const value = form.elements[field].value.trim();
    selectedCard[field] = value === "" ? null : Number(value);
  });
  qs("#formTitle").textContent = selectedCard.name;
  setDirty(true);
  renderPreview();
  applyFilters(false);
}

function renderPreview() {
  const card = selectedCard;
  if (!card) return;
  const preview = qs("#cardPreview");
  preview.className = `preview-card ${card.rarity.toLowerCase()}`;
  qs("#previewRarity").textContent = card.rarity;
  qs("#previewId").textContent = card.id;
  qs("#previewName").textContent = card.name || "Untitled card";
  qs("#previewType").textContent = (card.category || []).join(" / ") || "Uncategorized";
  qs("#previewValue").textContent = `Value: ${Math.max(Number(card.value) || 0, baseCreditValue(card.rarity)).toLocaleString()} credits`;
  qs("#previewExamine").textContent = card.examine || "No examine text.";
  const image = qs("#previewImage");
  const fallback = qs("#previewFallback");
  fallback.textContent = (card.name || "?").slice(0, 1);
  fallback.hidden = Boolean(card.imageUrl);
  image.hidden = !card.imageUrl;
  image.src = card.imageUrl || "";
}

function revertSelectedCard() {
  if (!selectedCard) return;
  const original = originalCards.find((card) => card.id === selectedCard.id);
  if (!original) return;
  Object.keys(selectedCard).forEach((key) => delete selectedCard[key]);
  Object.assign(selectedCard, cloneCards(original));
  fillForm(selectedCard);
  setDirty(JSON.stringify(cards) !== JSON.stringify(originalCards));
  applyFilters(false);
  renderPreview();
}

function addCard() {
  let id = `custom-${Date.now().toString(36)}`;
  let suffix = 1;
  while (cards.some((card) => card.id === id)) id = `custom-${Date.now().toString(36)}-${suffix++}`;
  const card = {
    id,
    name: "New card",
    category: [],
    imageUrl: "",
    level: null,
    value: baseCreditValue("Common"),
    geValue: null,
    highAlchValue: null,
    experience: null,
    overrideScore: null,
    examine: "",
    questItem: false,
    rarity: "Common",
    wikiTitle: ""
  };
  cards.unshift(card);
  qs("#searchInput").value = "";
  qs("#rarityFilter").value = "";
  qs("#typeFilter").value = "";
  qs("#imageFilter").value = "";
  page = 0;
  setDirty(true);
  populateFilters();
  applyFilters(false);
  selectCard(card.id);
  qs('#cardForm [name="name"]').select();
  showToast("New card added. Save JSON to make it permanent.");
}

function deleteSelectedCard() {
  const targets = checkedCardIds.size
    ? cards.filter((card) => checkedCardIds.has(card.id))
    : selectedCard ? [selectedCard] : [];
  if (!targets.length) return;
  const targetIds = new Set(targets.map((card) => card.id));
  const description = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} selected cards`;
  if (!window.confirm(`Delete ${description} from the card catalogue?`)) return;

  const filteredIndex = selectedCard ? filteredCards.indexOf(selectedCard) : 0;
  const rarityFilter = qs("#rarityFilter").value;
  const typeFilter = qs("#typeFilter").value;
  cards = cards.filter((card) => !targetIds.has(card.id));
  if (selectedCard && targetIds.has(selectedCard.id)) selectedCard = null;
  checkedCardIds.clear();
  lastCheckedCardId = null;
  setDirty(true);
  populateFilters();
  qs("#rarityFilter").value = rarityFilter;
  qs("#typeFilter").value = typeFilter;
  applyFilters(false);
  const nextCard = !selectedCard && (filteredCards[filteredIndex] || filteredCards[filteredIndex - 1] || null);
  if (nextCard) selectCard(nextCard.id);
  else if (!selectedCard) {
    qs("#cardFields").disabled = true;
    qs("#revertButton").disabled = true;
    qs("#deleteButton").disabled = true;
    qs("#formTitle").textContent = "No card selected";
  }
  updateDeleteButton();
  showToast(`Deleted ${targets.length.toLocaleString()} card${targets.length === 1 ? "" : "s"}. Save JSON to make it permanent.`);
}

async function loadCards(nextCards, label) {
  if (!Array.isArray(nextCards)) throw new Error("The JSON file must contain an array of cards.");
  cards = nextCards;
  originalCards = cloneCards(nextCards);
  selectedCard = null;
  checkedCardIds.clear();
  lastCheckedCardId = null;
  page = 0;
  populateFilters();
  applyFilters();
  setDirty(false);
  qs("#cardFields").disabled = true;
  qs("#revertButton").disabled = true;
  qs("#deleteButton").disabled = true;
  qs("#formTitle").textContent = "No card selected";
  showToast(`Loaded ${cards.length.toLocaleString()} cards from ${label}.`);
}

async function openFile(file) {
  try {
    await loadCards(JSON.parse(await file.text()), file.name);
  } catch (error) {
    showToast(error.message || "Unable to open that JSON file.");
  }
}

async function saveCards() {
  if (!cards.length) {
    showToast("The catalogue is empty. Reload or open a valid JSON file before saving.");
    return;
  }
  cards.forEach((card) => {
    card.value = Math.max(Number(card.value) || 0, baseCreditValue(card.rarity));
    delete card.creditValue;
  });
  if (selectedCard) fillForm(selectedCard);
  const contents = `${JSON.stringify(cards, null, 2)}\n`;
  let savedDirectly = false;
  let directSaveError = "";
  try {
    const endpoints = [...new Set([new URL("/api/cards", location.href).href, "http://127.0.0.1:8081/api/cards"] )];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: contents });
        if (!response.ok) throw new Error((await response.text()) || `Local save returned ${response.status}.`);
        savedDirectly = true;
        break;
      } catch (error) {
        directSaveError = error.message || "Local editor server could not be reached.";
      }
    }
    if (!savedDirectly) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      link.download = "generated-cards.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    originalCards = cloneCards(cards);
    setDirty(false);
    showToast(savedDirectly
      ? "Card catalogue saved to src/generated-cards.json."
      : `Catalogue downloaded. Start npm run editor for direct saving. ${directSaveError}`);
  } catch (error) {
    showToast(error.message || "Unable to save the catalogue.");
  }
}

function bind() {
  ["#searchInput", "#rarityFilter", "#typeFilter", "#imageFilter"].forEach((selector) => {
    qs(selector).addEventListener(selector === "#searchInput" ? "input" : "change", () => applyFilters());
  });
  qs("#previousPage").addEventListener("click", () => { page -= 1; renderList(); qs("#cardList").scrollTop = 0; });
  qs("#nextPage").addEventListener("click", () => { page += 1; renderList(); qs("#cardList").scrollTop = 0; });
  qs("#cardForm").addEventListener("input", updateSelectedCard);
  qs("#cardForm").addEventListener("change", updateSelectedCard);
  qs('#cardForm [name="rarity"]').addEventListener("change", () => {
    if (!selectedCard) return;
    selectedCard.value = Math.max(Number(selectedCard.value) || 0, baseCreditValue(selectedCard.rarity));
    qs('#cardForm [name="value"]').value = selectedCard.value;
    renderPreview();
  });
  qs("#cardFields").addEventListener("focusin", (event) => {
    highlightPreviewField(event.target.name);
  });
  qs("#cardFields").addEventListener("focusout", () => {
    window.setTimeout(() => {
      const activeField = qs("#cardFields").contains(document.activeElement) ? document.activeElement.name : "";
      highlightPreviewField(activeField);
    }, 0);
  });
  qs("#revertButton").addEventListener("click", revertSelectedCard);
  qs("#deleteButton").addEventListener("click", deleteSelectedCard);
  qs("#addButton").addEventListener("click", addCard);
  qs("#selectAllCards").addEventListener("change", (event) => {
    filteredCards.forEach((card) => {
      if (event.target.checked) checkedCardIds.add(card.id);
      else checkedCardIds.delete(card.id);
    });
    lastCheckedCardId = null;
    renderList();
    updateDeleteButton();
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isEditing = target.matches("input, textarea, select") || target.isContentEditable;
    if (event.key === "Delete" && !isEditing && (selectedCard || checkedCardIds.size)) {
      event.preventDefault();
      deleteSelectedCard();
    }
  });
  qs("#openButton").addEventListener("click", () => qs("#fileInput").click());
  qs("#fileInput").addEventListener("change", (event) => { if (event.target.files[0]) openFile(event.target.files[0]); event.target.value = ""; });
  qs("#saveButton").addEventListener("click", saveCards);
  qs("#previewImage").addEventListener("error", () => { qs("#previewImage").hidden = true; qs("#previewFallback").hidden = false; });
  window.addEventListener("beforeunload", (event) => { if (dirty) event.preventDefault(); });
}

bind();
Promise.all([fetch("./src/generated-cards.json"), fetch("./src/rarity-config.json")])
  .then(async ([cardsResponse, configResponse]) => {
    if (!cardsResponse.ok) throw new Error(`Catalogue returned ${cardsResponse.status}.`);
    if (!configResponse.ok) throw new Error(`Rarity config returned ${configResponse.status}.`);
    rarityConfig = await configResponse.json();
    return cardsResponse.json();
  })
  .then((data) => loadCards(data, "generated-cards.json"))
  .catch((error) => showToast(`${error.message} Open a JSON file to begin.`));
