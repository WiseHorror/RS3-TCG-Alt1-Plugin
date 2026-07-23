import * as a1lib from "alt1/base";
import XpcounterReader from "alt1-source/xpcounter";
import * as OCR from "alt1/ocr";
import chatfont from "alt1/fonts/chatbox/12pt.fontmeta.json";
import generatedCards from "./generated-cards.json";
import rarityConfig from "./rarity-config.json";
import economyConfig from "./economy-config.json";

// Economy and build-time configuration.
const CARDS = generatedCards;
const CARD_IDS = new Set(CARDS.map((card) => card.id));
const DEBUG_TOOLS = __DEBUG_TOOLS__;

const RARITY = rarityConfig;
const MAX_CARD_VALUE = economyConfig.packPrice * economyConfig.maxCardPackValue;
const BASE_SKILL_PACK_CHANCE = 1 / 500;
const MAX_SKILL_PACK_CHANCE = 1 / 100;
const BASE_SKILL_PACK_XP = 100;
const MAX_SKILL_PACK_XP = 1000;

function cardCreditValue(card) {
  return Math.min(MAX_CARD_VALUE, Math.max(Number(card.value) || 0, RARITY[card.rarity]?.baseCreditValue || 0));
}

function foilCardCreditValue(card) {
  return Math.min(MAX_CARD_VALUE, cardCreditValue(card) * FOIL_VALUE_MULTIPLIER);
}

const REWARD = {
  skill: { coins: 0, chance: BASE_SKILL_PACK_CHANCE, label: "Skill tick" }
};

const STORAGE_KEY = "rs3-tcg-save-v1";
const IMAGE_CACHE_KEY = "rs3-tcg-wiki-image-cache-v1";
const WIKI_API_URL = "https://runescape.wiki/api.php";
const PACK_PRICE = economyConfig.packPrice;
const CARDS_PER_PACK = 5;
const XP_PER_CREDIT = 10;
const RUNEMETRICS_READ_INTERVAL_MS = 600;
const RUNEMETRICS_RETRY_INTERVAL_MS = 2000;
const RUNEMETRICS_PANEL_WIDTH = 270;
const RUNEMETRICS_XP_COLUMN_X = 120;
const MAX_CREDIBLE_XP_DROP = 5_000_000;
const COLLECTION_PAGE_SIZE = 60;
const FOIL_CHANCE = 0.01;
const FOIL_VALUE_MULTIPLIER = 2;
const RESET_CONFIRMATION_MS = 8000;

// Runtime state shared by rendering, pack opening, and Alt1 detection.
const state = load();
const imageCache = loadImageCache();
const pendingImages = new Map();
let xpDetectionActive = false;
let xpDetectionMode = "none";
let runeMetricsReader = null;
let runeMetricsTimer = null;
let runeMetricsSearchTimer = null;
let runeMetricsBaseline = new Map();
let runeMetricsXpColumnX = RUNEMETRICS_XP_COLUMN_X;
let collectionPage = 0;
const unrevealedPackCards = new Set();
let packModalReturnFocus = null;
let creditsHelpReturnFocus = null;
let resetConfirmationTimer = null;
let audioContext = null;

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

// Pack sounds are synthesized locally to keep the app self-contained.
function getAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function playTone(frequency, duration, volume, delay = 0, type = "sine") {
  const adjustedVolume = volume * state.settings.soundVolume / 100;
  if (adjustedVolume <= 0) return;
  const context = getAudioContext();
  if (!context) return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(adjustedVolume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playPackOpenSound() {
  playTone(130, 0.18, 0.055, 0, "triangle");
  playTone(196, 0.25, 0.045, 0.08, "triangle");
}

function playCardDealSound(delay) {
  playTone(150, 0.07, 0.025, delay, "triangle");
}

function playCardRevealSound(cardElement, delay = 0) {
  const rarityIndex = Math.max(0, Object.keys(RARITY).indexOf(cardElement.dataset.rarity));
  const baseFrequency = 280 + rarityIndex * 55;
  playTone(baseFrequency, 0.16, 0.045, delay, "sine");
  playTone(baseFrequency * 1.5, 0.22, 0.035, delay + 0.035, "triangle");
  if (cardElement.dataset.foil === "true") {
    playTone(baseFrequency * 2, 0.38, 0.03, delay + 0.08, "sine");
  }
}

// Save data -------------------------------------------------------------------

function defaultState() {
  return {
    coins: 0,
    packs: 0,
    owned: {},
    foils: {},
    log: [],
    settings: {
      showDetectionInfo: false,
      soundVolume: 70
    }
  };
}

function normalizeCollection(collection) {
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return {};
  return Object.fromEntries(Object.entries(collection).flatMap(([cardId, copies]) => {
    const count = Math.floor(Number(copies));
    return CARD_IDS.has(cardId) && Number.isFinite(count) && count > 0 ? [[cardId, count]] : [];
  }));
}

function normalizeState(loaded) {
  const defaults = defaultState();
  const source = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  const soundVolume = Number(source.settings?.soundVolume ?? defaults.settings.soundVolume);
  return {
    coins: Math.max(0, Math.floor(Number(source.coins) || 0)),
    packs: Math.max(0, Math.floor(Number(source.packs) || 0)),
    owned: normalizeCollection(source.owned),
    foils: normalizeCollection(source.foils),
    log: Array.isArray(source.log) ? source.log.slice(0, 60).map((entry) => ({
      time: String(entry?.time || ""),
      message: String(entry?.message || "")
    })) : [],
    settings: {
      showDetectionInfo: Boolean(source.settings?.showDetectionInfo),
      soundVolume: Number.isFinite(soundVolume) ? Math.min(100, Math.max(0, soundVolume)) : defaults.settings.soundVolume
    }
  };
}

function load() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function exportSave() {
  const backup = {
    format: "runescape-tcg-save",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `runescape-tcg-save-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("The backup file could not be read.")), { once: true });
    reader.readAsText(file);
  });
}

async function importSave(file) {
  const status = qs("#saveBackupStatus");
  status.textContent = "Reading backup...";
  try {
    const backup = JSON.parse(await readFileText(file));
    if (backup?.format !== "runescape-tcg-save" || backup?.version !== 1 || !backup.data) {
      throw new Error("This is not a supported RuneScape TCG save backup.");
    }
    if (!window.confirm("Replace your current RuneScape TCG progress with this backup?")) {
      status.textContent = "Import cancelled.";
      return;
    }

    Object.keys(state).forEach((key) => { delete state[key]; });
    Object.assign(state, normalizeState(backup.data));
    collectionPage = 0;
    save();
    render();
    status.textContent = "Save restored successfully.";
  } catch (error) {
    status.textContent = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function resetProgress() {
  const button = qs("#resetButton");
  if (button.dataset.confirmReset !== "true") {
    button.dataset.confirmReset = "true";
    button.textContent = "Click again to reset";
    button.setAttribute("aria-label", "Click again to permanently reset progress");
    resetConfirmationTimer = window.setTimeout(() => {
      button.dataset.confirmReset = "false";
      button.textContent = "Reset";
      button.removeAttribute("aria-label");
      resetConfirmationTimer = null;
    }, RESET_CONFIRMATION_MS);
    return;
  }

  if (resetConfirmationTimer !== null) window.clearTimeout(resetConfirmationTimer);
  resetConfirmationTimer = null;
  stopXpDetection();
  localStorage.removeItem(STORAGE_KEY);
  Object.keys(state).forEach((key) => { delete state[key]; });
  Object.assign(state, defaultState());
  collectionPage = 0;
  button.dataset.confirmReset = "false";
  button.textContent = "Reset";
  button.removeAttribute("aria-label");
  save();
  render();
  startXpDetection();
}

// Wiki image URLs use a separate cache so resetting progress does not trigger
// thousands of avoidable MediaWiki requests.
function loadImageCache() {
  try {
    return JSON.parse(localStorage.getItem(IMAGE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveImageCache() {
  localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(imageCache));
}

function log(message) {
  state.log.unshift({ time: new Date().toLocaleTimeString(), message });
  state.log = state.log.slice(0, 60);
}

async function resolveWikiImage(card) {
  if (card.imageUrl) return card.imageUrl;
  if (imageCache[card.id]) return imageCache[card.id];
  if (pendingImages.has(card.id)) return pendingImages.get(card.id);

  const request = (async () => {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      prop: "pageimages",
      piprop: "thumbnail",
      pithumbsize: "220",
      redirects: "1",
      titles: card.wikiTitle
    });

    try {
      const response = await fetch(`${WIKI_API_URL}?${params.toString()}`);
      if (!response.ok) throw new Error(`Wiki API returned ${response.status}`);
      const data = await response.json();
      const pages = Object.values(data.query?.pages || {});
      const thumbnail = pages.find((page) => page.thumbnail?.source)?.thumbnail?.source;

      if (thumbnail) {
        imageCache[card.id] = thumbnail;
        saveImageCache();
        updateCardImages(card.id, thumbnail);
      }
      return thumbnail || null;
    } catch (error) {
      console.warn(`Failed to load wiki image for ${card.name}`, error);
      return null;
    } finally {
      pendingImages.delete(card.id);
    }
  })();
  pendingImages.set(card.id, request);
  return request;
}

function updateCardImages(cardId, source) {
  qsa(`[data-card-id="${cardId}"] .card-front .card-art img`).forEach((image) => {
    image.hidden = false;
    image.src = source;
    image.nextElementSibling.hidden = true;
  });
}

// Pack generation -------------------------------------------------------------

function rollRarity() {
  let roll = Math.random() * 100;
  for (const [rarity, config] of Object.entries(RARITY).reverse()) {
    if (roll < config.chance) return rarity;
    roll -= config.chance;
  }
  return "Common";
}

function cardScore(card) {
  const value = Number(card.value) || 0;
  const level = Number(card.level) || 0;
  const levelScore = card.overrideScore === null
    ? level ** 2 * ((card.category || []).includes("NPC") ? 1.5 : 1)
    : Math.max(0, Number(card.overrideScore) || 0);
  return Math.max(value, levelScore);
}

function pickFromTier(pool, rarity) {
  if (!["Legendary", "Mythic", "Godly"].includes(rarity) || pool.length < 2) {
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const scores = pool.map(cardScore);
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  if (maximum <= minimum) return pool[Math.floor(Math.random() * pool.length)];
  // Keep exceptionally valuable cards less common even after their rarity tier
  // has been selected. Weights range from 1 for the tier minimum to 1/3 for its maximum.
  const weights = scores.map((score) => 1 - (2 / 3) * ((score - minimum) / (maximum - minimum)));
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return pool[index];
  }
  return pool[pool.length - 1];
}

function weightedCard() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rarity = rollRarity();
    const pool = CARDS.filter((card) => card.rarity === rarity);
    if (pool.length) return pickFromTier(pool, rarity);
  }
  return CARDS[Math.floor(Math.random() * CARDS.length)];
}

function ownedCount(cardId) {
  return Number((state.owned || {})[cardId] || 0) + Number((state.foils || {})[cardId] || 0);
}

function balancedPackColumns(cardCount) {
  // Prefer a divisor so the last reveal row is full; prime counts are centered
  // by the flex container instead.
  const maximumColumns = Math.min(5, cardCount);
  for (let columns = maximumColumns; columns >= 2; columns -= 1) {
    if (cardCount % columns === 0) return columns;
  }
  return maximumColumns;
}

function openPack() {
  if (state.packs < 1) {
    if (state.coins < PACK_PRICE) {
      log(`${PACK_PRICE.toLocaleString()} credits required to buy a pack.`);
      render();
      return;
    }
    state.coins -= PACK_PRICE;
    state.packs += 1;
    log(`Bought an Origin Pack for ${PACK_PRICE.toLocaleString()} credits.`);
  }

  state.packs -= 1;
  playPackOpenSound();
  state.owned ||= {};
  state.foils ||= {};
  const opened = Array.from({ length: CARDS_PER_PACK }, weightedCard);
  const reveal = qs("#reveal");
  reveal.innerHTML = "";
  reveal.style.setProperty("--pack-card-width", `${100 / balancedPackColumns(opened.length)}%`);
  qs("#packModalTitle").textContent = `Your ${CARDS_PER_PACK} cards`;
  unrevealedPackCards.clear();

  opened.forEach((card) => {
    const count = ownedCount(card.id);
    const foil = Math.random() < FOIL_CHANCE;
    const newCard = count === 0;
    if (newCard) {
      log(`New${foil ? " foil" : ""} card: ${card.name}.`);
    } else {
      log(`Duplicate${foil ? " foil" : ""} card kept: ${card.name}.`);
    }
    const collection = foil ? state.foils : state.owned;
    collection[card.id] = Number(collection[card.id] || 0) + 1;
    reveal.append(cardNode(card, count + 1, true, { foil, newCard }));
  });

  save();
  render();
  openPackModal();
}

// Card UI and collection economy ---------------------------------------------

function openPackModal() {
  const modal = qs("#packModal");
  qsa("#packModal .pack-card.face-down").forEach((card) => unrevealedPackCards.add(card));
  packModalReturnFocus = document.activeElement;
  modal.hidden = false;
  qs("#revealAllCardsButton").disabled = unrevealedPackCards.size === 0;
  document.body.classList.add("modal-open");
  qs(".app-shell").inert = true;
  startPackDealAnimation(modal);
  const firstCard = modal.querySelector(".pack-card");
  (firstCard || qs("#closePackModal")).focus();
}

function startPackDealAnimation(modal) {
  const source = qs("#packOpeningSource");
  const cards = qsa("#packModal .pack-card");
  source.classList.remove("active");
  cards.forEach((card) => card.classList.remove("dealing"));

  // Wait for the visible modal to lay out, then translate each card from the
  // center pack to its already-reserved grid position.
  window.requestAnimationFrame(() => {
    const sourceRect = source.getBoundingClientRect();
    const sourceX = sourceRect.left + sourceRect.width / 2;
    const sourceY = sourceRect.top + sourceRect.height / 2;
    source.classList.add("active");
    cards.forEach((card, index) => {
      const cardRect = card.getBoundingClientRect();
      card.style.setProperty("--deal-x", `${sourceX - cardRect.left - cardRect.width / 2}px`);
      card.style.setProperty("--deal-y", `${sourceY - cardRect.top - cardRect.height / 2}px`);
      card.style.setProperty("--deal-delay", `${Math.min(index, 14) * 45}ms`);
      card.classList.add("dealing");
      playCardDealSound(0.16 + index * 0.045);
      card.addEventListener("animationend", () => card.classList.remove("dealing"), { once: true });
    });
  });
}

function closePackModal() {
  const modal = qs("#packModal");
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  qs(".app-shell").inert = false;
  unrevealedPackCards.clear();
  if (packModalReturnFocus && document.contains(packModalReturnFocus)) packModalReturnFocus.focus();
  packModalReturnFocus = null;
}

function cardNode(card, count, packReveal = false, options = {}) {
  const foil = Boolean(options.foil);
  const newCard = Boolean(options.newCard);
  const el = document.createElement("article");
  el.className = `card ${card.rarity.toLowerCase()}${count ? "" : " locked"}${foil ? " foil" : ""}${packReveal ? " pack-card face-down" : ""}`;
  el.dataset.cardId = card.id;
  el.dataset.rarity = card.rarity;
  el.dataset.foil = String(foil);
  const imageUrl = card.imageUrl || imageCache[card.id] || "";
  const sellValue = cardCreditValue(card);
  const normalCopies = Number((state.owned || {})[card.id] || 0);
  const foilCopies = Number((state.foils || {})[card.id] || 0);
  el.innerHTML = `
    <div class="card-face card-front">
      <div class="card-top">
        <span>${card.rarity}${newCard ? '<strong class="new-tag">NEW</strong>' : ""}${foil ? '<strong class="foil-tag">FOIL</strong>' : ""}</span>
        <strong>x${count || 0}</strong>
      </div>
      <div class="card-art">
        <img alt="" loading="lazy" hidden>
        <span>${card.name.slice(0, 1)}</span>
      </div>
      <h3>${card.name}</h3>
      <small class="card-value">Value: ${sellValue.toLocaleString()} credits${foil ? ` | Foil: ${foilCardCreditValue(card).toLocaleString()}` : ""}</small>
      <p>${card.examine || "No examine text."}</p>
      ${!packReveal && count ? `<div class="card-actions">
        ${normalCopies ? `<button type="button" data-sell="normal">Sell (${normalCopies})</button>` : ""}
        ${foilCopies ? `<button type="button" data-sell="foil">Sell foil (${foilCopies})</button>` : ""}
      </div>` : ""}
    </div>
    ${packReveal ? '<div class="card-face card-back" aria-hidden="true"><img class="card-back-logo" src="./assets/icon.png" alt=""><strong>RS TCG</strong></div>' : ""}
  `;
  el.querySelector("p").title = card.examine || "No examine text.";
  const artwork = el.querySelector(".card-art img");
  const artworkFallback = artwork.nextElementSibling;
  artwork.addEventListener("error", () => {
    artwork.hidden = true;
    artwork.removeAttribute("src");
    artworkFallback.hidden = false;
  });
  if (imageUrl) {
    artwork.src = imageUrl;
    artwork.hidden = false;
    artworkFallback.hidden = true;
  }
  el.querySelectorAll("[data-sell]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      sellCard(card, button.dataset.sell === "foil");
    });
  });
  if (packReveal) {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Face-down card. Click to reveal.");
    unrevealedPackCards.add(el);
    el.addEventListener("click", () => revealPackCard(el));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") revealPackCard(el);
    });
  }
  resolveWikiImage(card);
  return el;
}

function sellCard(card, foil = false) {
  const collection = foil ? state.foils : state.owned;
  const copies = Number((collection || {})[card.id] || 0);
  if (copies < 1) return;

  if (copies === 1) delete collection[card.id];
  else collection[card.id] = copies - 1;
  const value = foil ? foilCardCreditValue(card) : cardCreditValue(card);
  state.coins += value;
  log(`Sold ${foil ? "foil " : ""}${card.name} for ${value.toLocaleString()} credits.`);
  save();
  render();
}

function duplicateSale() {
  let copies = 0;
  let credits = 0;
  const sales = [];
  for (const card of CARDS) {
    const normalCopies = Number((state.owned || {})[card.id] || 0);
    const foilCopies = Number((state.foils || {})[card.id] || 0);
    // A foil satisfies ownership, allowing every normal copy to be considered a
    // duplicate. Otherwise one normal copy is retained.
    const normalToSell = foilCopies > 0 ? normalCopies : Math.max(0, normalCopies - 1);
    const foilsToSell = Math.max(0, foilCopies - 1);
    if (!normalToSell && !foilsToSell) continue;
    const value = cardCreditValue(card);
    copies += normalToSell + foilsToSell;
    credits += normalToSell * value + foilsToSell * foilCardCreditValue(card);
    sales.push({ card, normalToSell, foilsToSell });
  }
  return { copies, credits, sales };
}

function sellAllDuplicates() {
  const sale = duplicateSale();
  if (!sale.copies) return;
  if (!window.confirm(`Sell ${sale.copies.toLocaleString()} duplicate cards for ${sale.credits.toLocaleString()} credits?`)) return;
  for (const { card, normalToSell, foilsToSell } of sale.sales) {
    const normalRemaining = Number(state.owned[card.id] || 0) - normalToSell;
    const foilsRemaining = Number(state.foils[card.id] || 0) - foilsToSell;
    if (normalRemaining > 0) state.owned[card.id] = normalRemaining;
    else delete state.owned[card.id];
    if (foilsRemaining > 0) state.foils[card.id] = foilsRemaining;
    else delete state.foils[card.id];
  }
  state.coins += sale.credits;
  log(`Sold ${sale.copies.toLocaleString()} duplicate cards for ${sale.credits.toLocaleString()} credits.`);
  save();
  render();
}

function revealPackCard(cardElement, soundDelay = 0) {
  if (!unrevealedPackCards.delete(cardElement)) return;
  playCardRevealSound(cardElement, soundDelay);
  cardElement.classList.remove("face-down");
  cardElement.classList.add("revealed");
  cardElement.removeAttribute("role");
  cardElement.removeAttribute("aria-label");
  cardElement.tabIndex = -1;
  qs("#revealAllCardsButton").disabled = unrevealedPackCards.size === 0;
}

function revealAllPackCards() {
  [...unrevealedPackCards].forEach((card, index) => revealPackCard(card, index * 0.06));
}

function addReward(kind, statusText = "", coinOverride = null, chanceOverride = null) {
  const reward = REWARD[kind];
  const coins = coinOverride === null ? reward.coins : Math.max(0, Math.floor(Number(coinOverride) || 0));
  state.coins += coins;
  const chance = chanceOverride === null ? reward.chance : chanceOverride;
  const packDropped = Math.random() < chance;
  if (packDropped) {
    state.packs += 1;
    qs("#rewardStatus").textContent = statusText || `${reward.label}: +${coins} credits and a pack dropped.`;
    log(`${reward.label} awarded one pack.`);
  } else {
    qs("#rewardStatus").textContent = statusText || `${reward.label}: +${coins} credits.`;
  }
  save();
  render();
  if (packDropped) animateFreePackDrop();
}

function animateFreePackDrop() {
  const counter = qs("#packsStat");
  counter.classList.remove("free-pack-drop");
  void counter.offsetWidth;
  counter.classList.add("free-pack-drop");
  counter.addEventListener("animationend", () => counter.classList.remove("free-pack-drop"), { once: true });
}

function getSkillPackChance(xpGained) {
  const xp = Math.max(0, xpGained);
  if (xp < BASE_SKILL_PACK_XP) {
    return BASE_SKILL_PACK_CHANCE * (xp / BASE_SKILL_PACK_XP);
  }
  if (xp >= MAX_SKILL_PACK_XP) return MAX_SKILL_PACK_CHANCE;

  const progress = (xp - BASE_SKILL_PACK_XP) / (MAX_SKILL_PACK_XP - BASE_SKILL_PACK_XP);
  return BASE_SKILL_PACK_CHANCE
    + progress * (MAX_SKILL_PACK_CHANCE - BASE_SKILL_PACK_CHANCE);
}

function runDebugSkillTick() {
  const input = qs("#debugXpAmount");
  const xp = Math.max(0, Math.floor(Number(input.value) || 0));
  if (xp < 1) {
    qs("#rewardStatus").textContent = "Enter an XP amount greater than 0.";
    input.focus();
    return;
  }

  const credits = Math.ceil(xp / XP_PER_CREDIT);
  addReward(
    "skill",
    `Debug XP drop: +${xp.toLocaleString()} XP and +${credits.toLocaleString()} credits.`,
    credits,
    getSkillPackChance(xp)
  );
}

// Alt1 RuneMetrics XP detection ----------------------------------------------

function getAlt1Status() {
  return {
    hasAlt1: Boolean(window.alt1),
    installed: Boolean(window.alt1 && alt1.permissionInstalled),
    rsLinked: Boolean(window.alt1 && alt1.rsLinked),
    version: String((window.alt1 && alt1.version) || "unknown")
  };
}

function hasXpDetectionAccess() {
  const status = getAlt1Status();
  return status.hasAlt1
    && status.installed
    && status.rsLinked
    && Boolean(window.alt1?.permissionPixel);
}

function describeAlt1Status() {
  const status = getAlt1Status();
  if (!status.hasAlt1) return "Alt1 API not found. Open this app inside Alt1.";

  const missing = [];
  if (!status.installed) missing.push("installed app context");
  if (!status.rsLinked) missing.push("linked RuneScape window");
  if (!window.alt1.permissionPixel) missing.push("View screen permission");
  return missing.length
    ? `Missing: ${missing.join(", ")} (Alt1 ${status.version}).`
    : `Alt1 ${status.version} ready. RuneMetrics XP detection is active.`;
}

function setXpDetectionStatus(text, active = false) {
  const status = qs("#xpDetectionStatus");
  status.textContent = text;
  status.classList.toggle("active", active);
}

function checkAlt1Status() {
  const message = describeAlt1Status();
  setXpDetectionStatus(message, hasXpDetectionAccess());
  log(message);
  render();
  if (hasXpDetectionAccess() && !xpDetectionActive) startXpDetection();
}

function startXpDetection() {
  if (xpDetectionActive) return;
  if (!hasXpDetectionAccess()) {
    const message = describeAlt1Status();
    setXpDetectionStatus(message);
    log(message);
    render();
    return;
  }

  // Alt1 can inject its browser API after imported modules initialize.
  // Refresh the wrapper's cached environment before using capture helpers.
  a1lib.resetEnvironment();
  xpDetectionActive = true;
  xpDetectionMode = "runemetrics";
  startRuneMetricsDetection();
  render();
}

function stopXpDetection(message = "Idle") {
  if (runeMetricsTimer !== null) window.clearTimeout(runeMetricsTimer);
  if (runeMetricsSearchTimer !== null) window.clearTimeout(runeMetricsSearchTimer);
  runeMetricsTimer = null;
  runeMetricsSearchTimer = null;
  runeMetricsReader = null;
  runeMetricsBaseline.clear();
  xpDetectionActive = false;
  xpDetectionMode = "none";
  setXpDetectionStatus(message);
}

function startRuneMetricsDetection() {
  runeMetricsReader = new XpcounterReader();
  runeMetricsBaseline.clear();
  setXpDetectionStatus("Finding RuneMetrics counters", true);
  findRuneMetricsCounters();
}

function findRuneMetricsCounters() {
  if (!xpDetectionActive || xpDetectionMode !== "runemetrics" || !runeMetricsReader) return;
  runeMetricsReader.findAsync((position) => {
    if (!xpDetectionActive || !runeMetricsReader) return;
    if (!position) {
      runeMetricsBaseline.clear();
      setXpDetectionStatus("Waiting for visible RuneMetrics counters", true);
      runeMetricsSearchTimer = window.setTimeout(findRuneMetricsCounters, RUNEMETRICS_RETRY_INTERVAL_MS);
      return;
    }
    position.w = Math.min(RUNEMETRICS_PANEL_WIDTH, Math.max(160, Number(alt1.rsWidth) - position.x));
    runeMetricsXpColumnX = RUNEMETRICS_XP_COLUMN_X;
    runeMetricsBaseline.clear();
    readRuneMetricsCounters();
  });
}

function readRuneMetricsLine(buffer, baselineY) {
  const offsets = [0];
  for (let offset = 1; offset <= 20; offset += 1) offsets.push(-offset, offset);
  for (const offset of offsets) {
    const x = runeMetricsXpColumnX + offset;
    const result = OCR.readLine(buffer, chatfont, [255, 255, 255], x, baselineY, true, false);
    if (result?.text?.trim()) {
      runeMetricsXpColumnX = x;
      return result.text.trim();
    }
  }
  return "";
}

function parseRuneMetricsValue(text) {
  if (!text || /lots|xp\s*\/\s*h|\/\s*h/i.test(text)) return null;
  const match = text.match(/\d[\d,. ]*/);
  if (!match) return null;
  let multiplier = 1;
  if (/M(?:\s|$)/i.test(text)) multiplier = 1_000_000;
  else if (/[TK](?:\s|$)/i.test(text)) multiplier = 1_000;
  const raw = multiplier === 1
    ? match[0].replace(/[,\. ]/g, "")
    : match[0].replace(/,/g, ".").replace(/\s/g, "");
  const value = (multiplier === 1 ? Number.parseInt(raw, 10) : Number.parseFloat(raw)) * multiplier;
  return Number.isFinite(value) ? value : null;
}

function getRuneMetricsSnapshot() {
  const position = runeMetricsReader.pos;
  const image = a1lib.captureHold(position.x, position.y, position.w, (position.rows + 2) * 27);
  runeMetricsReader.readSkills(image);
  const buffer = image.toData(position.x, position.y, position.w, position.h);
  const readings = new Map();

  for (let index = 0; index < position.rows; index += 1) {
    const skill = runeMetricsReader.skills[index];
    const value = parseRuneMetricsValue(readRuneMetricsLine(buffer, index * 27 + 18));
    if (skill && value !== null) readings.set(skill, value);
  }
  return readings;
}

function hasSameRuneMetricsRows(readings) {
  return readings.size > 0
    && readings.size === runeMetricsBaseline.size
    && [...readings.keys()].every((skill) => runeMetricsBaseline.has(skill));
}

function calculateRuneMetricsGain(readings) {
  const deltas = [...readings].map(([skill, value]) => ({
    skill,
    delta: value - runeMetricsBaseline.get(skill)
  }));
  const invalid = deltas.some(({ delta }) => delta < 0 || delta > MAX_CREDIBLE_XP_DROP);
  if (invalid) return null;
  return deltas.find(({ skill }) => skill === "tot")?.delta
    ?? deltas.reduce((sum, { delta }) => sum + delta, 0);
}

function scheduleRuneMetricsRead() {
  runeMetricsTimer = window.setTimeout(readRuneMetricsCounters, RUNEMETRICS_READ_INTERVAL_MS);
}

function readRuneMetricsCounters() {
  if (!xpDetectionActive || xpDetectionMode !== "runemetrics" || !runeMetricsReader?.pos) return;
  try {
    const readings = getRuneMetricsSnapshot();
    if (!hasSameRuneMetricsRows(readings)) {
      runeMetricsBaseline = readings;
      const status = readings.size > 0
        ? `Calibrated ${readings.size} RuneMetrics counter${readings.size === 1 ? "" : "s"}`
        : "RuneMetrics found; waiting for XP values";
      setXpDetectionStatus(status, true);
    } else {
      const gained = calculateRuneMetricsGain(readings);
      runeMetricsBaseline = readings;
      if (gained > 0) {
        const credits = Math.ceil(gained / XP_PER_CREDIT);
        addReward(
          "skill",
          `Alt1 detected +${gained.toLocaleString()} XP: +${credits.toLocaleString()} credits.`,
          credits,
          getSkillPackChance(gained)
        );
      }
      setXpDetectionStatus(`Watching ${readings.size} RuneMetrics counter${readings.size === 1 ? "" : "s"}`, true);
    }
  } catch (error) {
    runeMetricsBaseline.clear();
    runeMetricsReader.pos = null;
    setXpDetectionStatus(`RuneMetrics read failed: ${error?.message || error}`);
    runeMetricsSearchTimer = window.setTimeout(findRuneMetricsCounters, 1000);
    return;
  }
  scheduleRuneMetricsRead();
}







// Rendering and interaction --------------------------------------------------

function renderCollection() {
  const search = qs("#searchInput").value.trim().toLowerCase();
  const rarity = qs("#rarityFilter").value;
  const ownership = qs("#ownershipFilter").value;
  const type = qs("#typeFilter").value;
  const sort = qs("#collectionSort").value;
  const grid = qs("#collectionGrid");
  grid.innerHTML = "";
  const matches = CARDS
    .filter((card) => rarity === "all" || card.rarity === rarity)
    .filter((card) => type === "all" || card.id.startsWith(`${type}-`))
    .filter((card) => {
      const normalCopies = Number((state.owned || {})[card.id] || 0);
      const foilCopies = Number((state.foils || {})[card.id] || 0);
      const totalCopies = normalCopies + foilCopies;
      if (ownership === "owned") return totalCopies > 0;
      if (ownership === "unowned") return totalCopies === 0;
      if (ownership === "duplicates") return totalCopies > 1;
      if (ownership === "foils") return foilCopies > 0;
      return true;
    })
    .filter((card) => `${card.name} ${(card.category || []).join(" ")} ${card.examine || ""}`.toLowerCase().includes(search));
  const rarityOrder = Object.keys(RARITY);
  const nameCompare = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  matches.sort((left, right) => {
    let difference = 0;
    if (sort === "name-desc") return -nameCompare(left, right);
    if (sort === "value-desc") difference = cardCreditValue(right) - cardCreditValue(left);
    else if (sort === "value-asc") difference = cardCreditValue(left) - cardCreditValue(right);
    else if (sort === "rarity-desc") difference = rarityOrder.indexOf(right.rarity) - rarityOrder.indexOf(left.rarity);
    else if (sort === "rarity-asc") difference = rarityOrder.indexOf(left.rarity) - rarityOrder.indexOf(right.rarity);
    else if (sort === "owned-desc") difference = ownedCount(right.id) - ownedCount(left.id);
    else if (sort === "owned-asc") difference = ownedCount(left.id) - ownedCount(right.id);
    else if (sort === "category-asc") {
      difference = (left.category || []).join(" ").localeCompare((right.category || []).join(" "), undefined, { sensitivity: "base" });
    }
    return difference || nameCompare(left, right);
  });
  const pageCount = Math.max(1, Math.ceil(matches.length / COLLECTION_PAGE_SIZE));
  collectionPage = Math.min(collectionPage, pageCount - 1);
  matches
    .slice(collectionPage * COLLECTION_PAGE_SIZE, (collectionPage + 1) * COLLECTION_PAGE_SIZE)
    .forEach((card) => {
      const foil = Number((state.foils || {})[card.id] || 0) > 0;
      grid.append(cardNode(card, ownedCount(card.id), false, { foil }));
    });
  qs("#collectionPageStatus").textContent = `${matches.length.toLocaleString()} cards | Page ${collectionPage + 1} of ${pageCount}`;
  qs("#previousCollectionPage").disabled = collectionPage === 0;
  qs("#nextCollectionPage").disabled = collectionPage >= pageCount - 1;
}

function render() {
  qs("#installButton").hidden = Boolean(window.alt1);
  const ownedUnique = CARDS.filter((card) => ownedCount(card.id) > 0).length;
  qs("#coins").textContent = state.coins.toLocaleString();
  qs("#packs").textContent = state.packs.toLocaleString();
  qs("#packArtCount").textContent = `x${state.packs.toLocaleString()}`;
  const hasPack = state.packs > 0;
  qs("#openPackButton").textContent = hasPack ? "Open Pack" : `Buy Pack (${PACK_PRICE.toLocaleString()})`;
  qs("#openPackButton").disabled = !hasPack && state.coins < PACK_PRICE;
  qs("#packDescription").textContent = `Contains ${CARDS_PER_PACK} RuneScape-themed cards. Duplicates are kept and can be sold from the collection.`;
  qs("#ownedCount").textContent = `${ownedUnique}/${CARDS.length}`;
  qs("#activityPanel").hidden = !state.settings.showDetectionInfo;
  qs("#showDetectionInfoToggle").checked = Boolean(state.settings.showDetectionInfo);
  qs("#soundVolume").value = String(state.settings.soundVolume);
  qs("#soundVolumeValue").textContent = `${state.settings.soundVolume}%`;
  const duplicateSummary = duplicateSale();
  qs("#sellDuplicatesButton").disabled = duplicateSummary.copies === 0;
  qs("#sellDuplicatesButton").textContent = duplicateSummary.copies
    ? `Sell duplicates (${duplicateSummary.copies.toLocaleString()})`
    : "Sell duplicates";
  qs("#eventLog").innerHTML = state.log.map((entry) => `<li><time>${entry.time}</time>${entry.message}</li>`).join("");
  renderCollection();
}

function configureDebugTools() {
  qsa("[data-debug-feature]").forEach((element) => {
    if (DEBUG_TOOLS) element.hidden = false;
    else element.remove();
  });
}

function installAlt1() {
  const manifest = new URL("./appconfig.json", location.href).href;
  location.href = `alt1://addapp/${manifest}`;
}

function identifyAlt1App() {
  if (!window.alt1 || !alt1.identifyAppUrl) return;
  alt1.identifyAppUrl(new URL("./appconfig.json", location.href).href);
}

function openCreditsHelp() {
  creditsHelpReturnFocus = document.activeElement;
  qs("#creditsHelpModal").hidden = false;
  document.body.classList.add("modal-open");
  qs("#closeCreditsHelp").focus();
}

function closeCreditsHelp() {
  qs("#creditsHelpModal").hidden = true;
  document.body.classList.remove("modal-open");
  creditsHelpReturnFocus?.focus();
  creditsHelpReturnFocus = null;
}

function bind() {
  qs("#openPackButton").addEventListener("click", openPack);
  qs("#closePackModal").addEventListener("click", closePackModal);
  qs("#revealAllCardsButton").addEventListener("click", revealAllPackCards);
  qs("#packModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget && unrevealedPackCards.size === 0) closePackModal();
  });
  qs("#installButton").addEventListener("click", installAlt1);
  qs("#creditsHelpButton").addEventListener("click", openCreditsHelp);
  qs("#closeCreditsHelp").addEventListener("click", closeCreditsHelp);
  qs("#creditsHelpModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeCreditsHelp();
  });
  qs("#alt1StatusButton").addEventListener("click", checkAlt1Status);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !qs("#creditsHelpModal").hidden) {
      event.preventDefault();
      closeCreditsHelp();
      return;
    }
    if (event.key === "Escape" && !qs("#packModal").hidden) {
      event.preventDefault();
      closePackModal();
      return;
    }
    if (event.key === "Tab" && !qs("#packModal").hidden) {
      const focusable = qsa("#packModal button:not([disabled]), #packModal [tabindex='0']");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.code !== "Space" || event.repeat || !unrevealedPackCards.size) return;
    if (event.target instanceof Element
      && (event.target.matches("input, textarea, select") || event.target.isContentEditable)) return;
    event.preventDefault();
    revealAllPackCards();
  });
  if (DEBUG_TOOLS) {
    qs("#debugSkillTickButton").addEventListener("click", runDebugSkillTick);
  }
  qsa(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      qsa(".tab, .view").forEach((el) => el.classList.remove("active"));
      tab.classList.add("active");
      qs(`#${tab.dataset.view}`).classList.add("active");
    });
  });
  qs("#searchInput").addEventListener("input", () => {
    collectionPage = 0;
    renderCollection();
  });
  ["#rarityFilter", "#ownershipFilter", "#typeFilter", "#collectionSort"].forEach((selector) => {
    qs(selector).addEventListener("change", () => {
      collectionPage = 0;
      renderCollection();
    });
  });
  qs("#previousCollectionPage").addEventListener("click", () => {
    collectionPage = Math.max(0, collectionPage - 1);
    renderCollection();
  });
  qs("#nextCollectionPage").addEventListener("click", () => {
    collectionPage += 1;
    renderCollection();
  });
  qs("#sellDuplicatesButton").addEventListener("click", sellAllDuplicates);
  qs("#showDetectionInfoToggle").addEventListener("change", (event) => {
    state.settings.showDetectionInfo = event.target.checked;
    save();
    render();
  });
  qs("#soundVolume").addEventListener("input", (event) => {
    state.settings.soundVolume = Number(event.target.value);
    qs("#soundVolumeValue").textContent = `${state.settings.soundVolume}%`;
    save();
  });
  qs("#resetButton").addEventListener("click", resetProgress);
  qs("#exportSaveButton").addEventListener("click", exportSave);
  qs("#importSaveInput").addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (file) await importSave(file);
    event.target.value = "";
  });
}

configureDebugTools();
bind();
identifyAlt1App();
render();
window.rs3Tcg = {
  ...(DEBUG_TOOLS ? { addReward } : {}),
  openPack,
  startXpDetection,
  stopXpDetection,
  checkAlt1Status
};
startXpDetection();
window.addEventListener("focus", () => {
  startXpDetection();
});
