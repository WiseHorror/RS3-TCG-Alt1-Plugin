import XpcounterReader from "alt1-source/xpcounter";
import * as a1lib from "alt1/base";
import * as OCR from "alt1/ocr";
import chatfont from "alt1/fonts/chatbox/12pt.fontmeta.json";
import generatedCards from "./generated-cards.json";
import rarityConfig from "./rarity-config.json";
import economyConfig from "./economy-config.json";

const CARDS = generatedCards;
const DEBUG_TOOLS = __DEBUG_TOOLS__;

const RARITY = rarityConfig;
const MAX_CARD_VALUE = economyConfig.packPrice * economyConfig.maxCardPackValue;

function cardCreditValue(card) {
  return Math.min(MAX_CARD_VALUE, Math.max(Number(card.value) || 0, RARITY[card.rarity]?.baseCreditValue || 0));
}

function foilCardCreditValue(card) {
  return Math.min(MAX_CARD_VALUE, cardCreditValue(card) * FOIL_VALUE_MULTIPLIER);
}

const REWARD = {
  skill: { coins: 80, chance: 0.001, label: "Skill tick" },
  boss: { coins: 260, chance: 0, label: "Boss kill" },
  clue: { coins: 420, chance: 0.1, label: "Clue casket" }
};

const STORAGE_KEY = "rs3-tcg-save-v1";
const IMAGE_CACHE_KEY = "rs3-tcg-wiki-image-cache-v1";
const WIKI_API_URL = "https://runescape.wiki/api.php";
const PACK_PRICE = economyConfig.packPrice;
const CARDS_PER_PACK = 5;
const XP_PER_CREDIT = 10;
const XP_BASELINE_WARMUP_MS = 10000;
const COLLECTION_PAGE_SIZE = 60;
const FOIL_CHANCE = 0.01;
const FOIL_VALUE_MULTIPLIER = 2;
const RESET_CONFIRMATION_MS = 8000;
const RUNEMETRICS_PANEL_WIDTH = 270;
const RUNEMETRICS_XP_COLUMN_X = 120;
const state = load();
const imageCache = loadImageCache();
const pendingImages = new Map();
let xpDetectionActive = false;
let lastXpBySkill = new Map();
let pendingXpBySkill = new Map();
let xpCounterReader = null;
let xpReadTimer = null;
let xpSearchTimer = null;
let xpReadMisses = 0;
let xpBaselineWarmupUntil = 0;
let xpDetectionGeneration = 0;
let runeMetricsXpColumnX = RUNEMETRICS_XP_COLUMN_X;
let collectionPage = 0;
const unrevealedPackCards = new Set();
let packModalReturnFocus = null;
let resetConfirmationTimer = null;

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

function defaultState() {
  return {
    coins: 0,
    packs: 0,
    owned: {},
    foils: {},
    log: [],
    creditSetup: "zero",
    settings: {
      showDetectionInfo: false
    }
  };
}

function load() {
  try {
    const loaded = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const defaults = defaultState();
    const hasExistingProgress = Number(loaded.coins) > 0
      || Object.keys(loaded.owned || {}).length > 0
      || Object.keys(loaded.foils || {}).length > 0
      || Array.isArray(loaded.log) && loaded.log.length > 0;
    return {
      ...defaults,
      ...loaded,
      owned: loaded.owned || defaults.owned,
      foils: loaded.foils || defaults.foils,
      creditSetup: loaded.creditSetup === "pending"
        ? "zero"
        : loaded.creditSetup || (hasExistingProgress ? "legacy" : defaults.creditSetup),
      settings: {
        showDetectionInfo: Boolean((loaded.settings || {}).showDetectionInfo)
      }
    };
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  const maximumColumns = Math.min(5, cardCount);
  for (let columns = maximumColumns; columns >= 2; columns -= 1) {
    if (cardCount % columns === 0) return columns;
  }
  return maximumColumns;
}

function openPack(quantity = 1) {
  const packQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  if (state.packs < packQuantity) {
    log(`${packQuantity.toLocaleString()} packs required.`);
    render();
    return;
  }

  state.packs -= packQuantity;
  state.owned ||= {};
  state.foils ||= {};
  const opened = Array.from({ length: CARDS_PER_PACK * packQuantity }, weightedCard);
  const reveal = qs("#reveal");
  reveal.innerHTML = "";
  reveal.style.setProperty("--pack-card-width", `${100 / balancedPackColumns(opened.length)}%`);
  qs("#packModalTitle").textContent = packQuantity === 1
    ? `Your ${CARDS_PER_PACK} cards`
    : `${packQuantity.toLocaleString()} packs | ${opened.length.toLocaleString()} cards`;
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

function openPackModal() {
  const modal = qs("#packModal");
  qsa("#packModal .pack-card.face-down").forEach((card) => unrevealedPackCards.add(card));
  packModalReturnFocus = document.activeElement;
  modal.hidden = false;
  qs("#revealAllCardsButton").disabled = unrevealedPackCards.size === 0;
  document.body.classList.add("modal-open");
  qs(".app-shell").inert = true;
  const firstCard = modal.querySelector(".pack-card");
  (firstCard || qs("#closePackModal")).focus();
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
  const imageUrl = card.imageUrl || imageCache[card.id] || "";
  const type = (card.category || [])[1] || (card.category || [])[0] || "Unknown";
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
      <small>${type}</small>
      <small class="card-value">Value: ${sellValue.toLocaleString()} credits${foil ? ` | Foil: ${foilCardCreditValue(card).toLocaleString()}` : ""}</small>
      <p>${card.examine || "No examine text."}</p>
      ${!packReveal && count ? `<div class="card-actions">
        ${normalCopies ? `<button type="button" data-sell="normal">Sell (${normalCopies})</button>` : ""}
        ${foilCopies ? `<button type="button" data-sell="foil">Sell foil (${foilCopies})</button>` : ""}
      </div>` : ""}
    </div>
    ${packReveal ? '<div class="card-face card-back" aria-hidden="true"><img class="card-back-logo" src="./assets/rs-logo.png" alt=""><strong>RS TCG</strong></div>' : ""}
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

function revealPackCard(cardElement) {
  if (!unrevealedPackCards.delete(cardElement)) return;
  cardElement.classList.remove("face-down");
  cardElement.classList.add("revealed");
  cardElement.removeAttribute("role");
  cardElement.removeAttribute("aria-label");
  cardElement.tabIndex = -1;
  qs("#revealAllCardsButton").disabled = unrevealedPackCards.size === 0;
}

function revealAllPackCards() {
  [...unrevealedPackCards].forEach(revealPackCard);
}

function buyPack(quantity = 1) {
  const packQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const totalPrice = PACK_PRICE * packQuantity;
  if (!Number.isSafeInteger(totalPrice) || state.coins < totalPrice) {
    log(`Not enough credits to buy ${packQuantity.toLocaleString()} packs (${totalPrice.toLocaleString()} required).`);
  } else {
    state.coins -= totalPrice;
    state.packs += packQuantity;
    log(`Bought ${packQuantity.toLocaleString()} Origin ${packQuantity === 1 ? "Pack" : "Packs"} for ${totalPrice.toLocaleString()} credits.`);
  }
  save();
  render();
}

function addReward(kind, statusText = "", coinOverride = null) {
  const reward = REWARD[kind];
  const coins = coinOverride === null ? reward.coins : Math.max(0, Math.floor(Number(coinOverride) || 0));
  state.coins += coins;
  const chance = reward.chance;
  if (Math.random() < chance) {
    state.packs += 1;
    qs("#rewardStatus").textContent = statusText || `${reward.label}: +${coins} credits and a pack dropped.`;
    log(`${reward.label} awarded ${coins.toLocaleString()} credits and one pack.`);
  } else {
    qs("#rewardStatus").textContent = statusText || `${reward.label}: +${coins} credits.`;
    log(`${reward.label} awarded ${coins.toLocaleString()} credits.`);
  }
  save();
  render();
}

function getAlt1Status() {
  return {
    hasAlt1: Boolean(window.alt1),
    installed: Boolean(window.alt1 && alt1.permissionInstalled),
    rsLinked: Boolean(window.alt1 && alt1.rsLinked),
    permissionPixel: Boolean(window.alt1 && alt1.permissionPixel),
    version: String((window.alt1 && alt1.version) || "unknown")
  };
}

function hasXpDetectionAccess() {
  const status = getAlt1Status();
  return status.hasAlt1 && status.installed && status.rsLinked && status.permissionPixel;
}

function describeAlt1Status() {
  const status = getAlt1Status();
  if (!status.hasAlt1) return "Alt1 API not found. Open this app inside Alt1.";

  const missing = [];
  if (!status.installed) missing.push("installed app context");
  if (!status.rsLinked) missing.push("linked RuneScape window");
  if (!status.permissionPixel) missing.push("View screen permission");
  return missing.length
    ? `Missing: ${missing.join(", ")} (Alt1 ${status.version}).`
    : `Alt1 ${status.version} ready. RuneMetrics screen reader is available.`;
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

  xpDetectionActive = true;
  xpDetectionGeneration += 1;
  lastXpBySkill.clear();
  pendingXpBySkill.clear();
  xpBaselineWarmupUntil = Date.now() + XP_BASELINE_WARMUP_MS;
  xpReadMisses = 0;
  xpCounterReader = new XpcounterReader();
  setXpDetectionStatus("Finding RuneMetrics counters", true);
  log("RuneMetrics XP screen reader started.");
  render();
  findXpCounters();
}

function findXpCounters() {
  if (!xpDetectionActive || !xpCounterReader || xpCounterReader.searching) return;
  const reader = xpCounterReader;
  const generation = xpDetectionGeneration;
  setXpDetectionStatus("Finding RuneMetrics counters", true);
  reader.findAsync((position) => {
    if (!xpDetectionActive || xpCounterReader !== reader || xpDetectionGeneration !== generation) return;
    if (!position) {
      setXpDetectionStatus("Waiting for visible RuneMetrics counters", true);
      xpSearchTimer = window.setTimeout(findXpCounters, 2500);
      return;
    }

    position.w = Math.min(RUNEMETRICS_PANEL_WIDTH, Math.max(160, Number(alt1.rsWidth) - position.x));
    runeMetricsXpColumnX = RUNEMETRICS_XP_COLUMN_X;
    lastXpBySkill.clear();
    pendingXpBySkill.clear();
    xpBaselineWarmupUntil = Date.now() + XP_BASELINE_WARMUP_MS;
    xpReadMisses = 0;
    readXpCounters();
    xpReadTimer = window.setInterval(readXpCounters, 300);
  });
}

function stopXpDetection(message = "Idle") {
  xpDetectionGeneration += 1;
  if (xpReadTimer !== null) {
    window.clearInterval(xpReadTimer);
    xpReadTimer = null;
  }
  if (xpSearchTimer !== null) {
    window.clearTimeout(xpSearchTimer);
    xpSearchTimer = null;
  }
  xpDetectionActive = false;
  xpCounterReader = null;
  lastXpBySkill.clear();
  pendingXpBySkill.clear();
  xpBaselineWarmupUntil = 0;
  setXpDetectionStatus(message);
}

function readXpCounters() {
  if (!xpDetectionActive || !xpCounterReader || !xpCounterReader.pos) return;
  let rows;
  try {
    rows = readRuneMetricsRows();
  } catch (error) {
    log(`RuneMetrics read error: ${error && error.message ? error.message : error}`);
    restartXpCounterSearch();
    return;
  }

  const rateRows = rows.filter((row) => row.isRate);
  if (rateRows.length) {
    setXpDetectionStatus("RuneMetrics is showing XP/h; switch counters to XP", false);
    rateRows.forEach((row) => {
      lastXpBySkill.delete(row.skill);
      pendingXpBySkill.delete(row.skill);
    });
  }

  const readings = new Map(
    rows
      .filter((row) => !row.isRate && Number.isFinite(row.value) && row.value >= 0)
      .map((row) => [row.skill, row.value])
  );
  if (!readings.size && rateRows.length) return;
  if (!readings.size) {
    xpReadMisses += 1;
    setXpDetectionStatus(
      rows.length ? "Counters found; waiting for exact XP values" : "Counters found; calibrating XP column",
      true
    );
    if (xpReadMisses >= 20 && !rows.length) restartXpCounterSearch();
    return;
  }

  xpReadMisses = 0;
  if (Date.now() < xpBaselineWarmupUntil || !lastXpBySkill.size) {
    readings.forEach((xp, skill) => lastXpBySkill.set(skill, xp));
    pendingXpBySkill.clear();
    const rounded = xpCounterReader.rounded ? " (rounded values)" : "";
    const warmupSeconds = Math.ceil((xpBaselineWarmupUntil - Date.now()) / 1000);
    const status = warmupSeconds > 0
      ? `Calibrating XP baseline (${warmupSeconds}s)`
      : `Watching ${readings.size} counter${readings.size === 1 ? "" : "s"}${rounded}`;
    setXpDetectionStatus(status, true);
    return;
  }

  let totalDelta = 0;
  let skillDelta = 0;
  readings.forEach((xp, skill) => {
    if (!lastXpBySkill.has(skill)) {
      lastXpBySkill.set(skill, xp);
      pendingXpBySkill.delete(skill);
      return;
    }

    const pending = pendingXpBySkill.get(skill);
    const confirmations = pending && pending.value === xp ? pending.confirmations + 1 : 1;
    pendingXpBySkill.set(skill, { value: xp, confirmations });
    if (confirmations < 2) return;

    const previousXp = lastXpBySkill.get(skill);
    const delta = xp - previousXp;
    if (delta > 0) {
      if (skill === "tot") totalDelta += delta;
      else skillDelta += delta;
    }
    if (delta >= 0) lastXpBySkill.set(skill, xp);
  });

  const gained = lastXpBySkill.has("tot") ? totalDelta : skillDelta;
  if (gained <= 0) return;

  const coins = Math.floor(gained / XP_PER_CREDIT);
  if (coins <= 0) return;

  addReward(
    "skill",
    `Alt1 detected +${gained.toLocaleString()} XP: +${coins.toLocaleString()} credits.`,
    coins
  );
}

function readRuneMetricsRows() {
  const position = xpCounterReader.pos;
  const image = a1lib.captureHold(position.x, position.y, position.w, (position.rows + 2) * 27);
  xpCounterReader.readSkills(image);
  const buffer = image.toData(position.x, position.y, position.w, position.h);
  const rows = [];
  let rounded = false;

  for (let index = 0; index < position.rows; index += 1) {
    const result = readXpColumnLine(buffer, index * 27 + 18);
    if (!result) continue;

    const text = result.text.trim();
    const isRate = /(?:xp\s*\/\s*h|\/\s*h|per\s+hour)/i.test(text);
    let multiplier = 1;
    if (/M(?:\s|$)/i.test(text)) {
      multiplier = 1_000_000;
      rounded = true;
    } else if (/[TK](?:\s|$)/i.test(text)) {
      multiplier = 1_000;
      rounded = true;
    }

    const numericText = text.match(/[\d][\d,. ]*/)?.[0] || "";
    const normalized = multiplier === 1
      ? numericText.replace(/[,\. ]/g, "")
      : numericText.replace(/,/g, ".").replace(/\s/g, "");
    const value = (multiplier === 1 ? Number.parseInt(normalized, 10) : Number.parseFloat(normalized)) * multiplier;
    const skill = xpCounterReader.skills[index];
    if (skill) rows.push({ skill, value, text, isRate });
  }

  xpCounterReader.rounded = rounded;
  return rows;
}

function readXpColumnLine(buffer, baselineY) {
  const offsets = [0];
  for (let offset = 1; offset <= 20; offset += 1) offsets.push(-offset, offset);

  for (const offset of offsets) {
    const x = runeMetricsXpColumnX + offset;
    const result = OCR.readLine(buffer, chatfont, [255, 255, 255], x, baselineY, true, false);
    if (result && result.text.trim()) {
      runeMetricsXpColumnX = x;
      return result;
    }
  }
  return null;
}

function restartXpCounterSearch() {
  if (xpReadTimer !== null) {
    window.clearInterval(xpReadTimer);
    xpReadTimer = null;
  }
  if (!xpCounterReader) return;
  xpCounterReader.pos = null;
  lastXpBySkill.clear();
  pendingXpBySkill.clear();
  xpBaselineWarmupUntil = Date.now() + XP_BASELINE_WARMUP_MS;
  xpReadMisses = 0;
  findXpCounters();
}

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
  qs("#buyPackButton").textContent = `Buy 1 (${PACK_PRICE.toLocaleString()})`;
  qs("#buyTenPacksButton").textContent = `Buy 10 (${(PACK_PRICE * 10).toLocaleString()})`;
  qs("#openPackButton").disabled = state.packs < 1;
  qs("#openTenPacksButton").disabled = state.packs < 10;
  qs("#buyPackButton").disabled = state.coins < PACK_PRICE;
  qs("#buyTenPacksButton").disabled = state.coins < PACK_PRICE * 10;
  const affordablePacks = Math.floor(state.coins / PACK_PRICE);
  qs("#buyMaxPacksButton").disabled = affordablePacks < 1;
  qs("#buyMaxPacksButton").textContent = affordablePacks > 0
    ? `Buy Max (${affordablePacks.toLocaleString()})`
    : "Buy Max";
  const customQuantity = Math.max(1, Math.floor(Number(qs("#packPurchaseQuantity").value) || 1));
  qs("#buyCustomPacksButton").disabled = !Number.isSafeInteger(PACK_PRICE * customQuantity)
    || state.coins < PACK_PRICE * customQuantity;
  qs("#packDescription").textContent = `Contains ${CARDS_PER_PACK} RuneScape-themed cards. Duplicates are kept and can be sold from the collection.`;
  qs("#ownedCount").textContent = `${ownedUnique}/${CARDS.length}`;
  qs("#activityPanel").hidden = !state.settings.showDetectionInfo;
  qs("#showDetectionInfoToggle").checked = Boolean(state.settings.showDetectionInfo);
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

function bind() {
  qs("#openPackButton").addEventListener("click", openPack);
  qs("#buyPackButton").addEventListener("click", buyPack);
  qs("#openTenPacksButton").addEventListener("click", () => openPack(10));
  qs("#buyTenPacksButton").addEventListener("click", () => buyPack(10));
  qs("#buyCustomPacksButton").addEventListener("click", () => buyPack(qs("#packPurchaseQuantity").value));
  qs("#buyMaxPacksButton").addEventListener("click", () => buyPack(Math.floor(state.coins / PACK_PRICE)));
  qs("#packPurchaseQuantity").addEventListener("input", render);
  qs("#closePackModal").addEventListener("click", closePackModal);
  qs("#revealAllCardsButton").addEventListener("click", revealAllPackCards);
  qs("#packModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget && unrevealedPackCards.size === 0) closePackModal();
  });
  qs("#installButton").addEventListener("click", installAlt1);
  qs("#alt1StatusButton").addEventListener("click", checkAlt1Status);
  document.addEventListener("keydown", (event) => {
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
    qsa("[data-reward]").forEach((button) => button.addEventListener("click", () => addReward(button.dataset.reward)));
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
  qs("#resetButton").addEventListener("click", resetProgress);
}

configureDebugTools();
bind();
identifyAlt1App();
render();
startXpDetection();
window.addEventListener("focus", () => {
  startXpDetection();
});
window.rs3Tcg = {
  ...(DEBUG_TOOLS ? { addReward } : {}),
  openPack,
  startXpDetection,
  stopXpDetection,
  checkAlt1Status,
  exportSave: () => btoa(JSON.stringify(state)),
  importSave: (saveText) => {
    const imported = JSON.parse(atob(saveText));
    Object.assign(state, imported);
    state.owned ||= {};
    state.foils ||= {};
    state.creditSetup = imported.creditSetup === "pending" ? "zero" : imported.creditSetup || "legacy";
    state.settings = { ...defaultState().settings, ...(state.settings || {}) };
    save();
    render();
  }
};
