const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const { canonicalBaseTitle, isEligibleItem, isOverviewCard } = require("./card-eligibility");
const { cardCreditValue, cardSourceValue } = require("./card-value");

const API_URL = "https://runescape.wiki/api.php";
const GE_DUMP_URL = "https://chisel.weirdgloop.org/gazproj/gazbot/rs_dump.json";
const OUTPUT_FILE = path.resolve(__dirname, "../src/generated-cards.json");
const RARITY_CONFIG = require("../src/rarity-config.json");
const PAGE_SIZE = 500;
const EXAMINE_BATCH_SIZE = 40;
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 6;
const XP_SCORE_MULTIPLIER = 100;
const SOURCES = [
  { category: "Treasure Trails rewards", kind: "item", tags: ["Resource", "Clue Reward"], preserveVariants: true },
  { category: "Materials", kind: "component", tags: ["Resource", "Invention Component"] },
  { category: "Tradeable items", kind: "item", tags: ["Resource", "Tradeable Item"] },
  { category: "Untradeable items", kind: "item", tags: ["Resource", "Skill-created Item"], recipeCandidates: true },
  { category: "Capes of Accomplishment", kind: "item", tags: ["Resource", "Accomplishment"], recursive: true },
  { category: "Monsters by combat level", kind: "npc", tags: ["NPC"], recursive: true },
  { category: "Rocks", kind: "node", tags: ["Resource", "Mining"] },
  { category: "Trees", kind: "node", tags: ["Resource", "Woodcutting"] },
  { category: "Fishing spots", kind: "node", tags: ["Resource", "Fishing"] },
  { category: "Excavation hotspots", kind: "node", tags: ["Resource", "Archaeology"] },
  { category: "Wisps", kind: "node", tags: ["Resource", "Divination"] }
];
const TIERS = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Godly"];
const SKILLS = [
  "Attack", "Strength", "Defence", "Constitution", "Ranged", "Prayer", "Magic", "Cooking",
  "Woodcutting", "Fletching", "Fishing", "Firemaking", "Crafting", "Smithing", "Mining",
  "Herblore", "Agility", "Thieving", "Slayer", "Farming", "Runecrafting", "Hunter",
  "Construction", "Summoning", "Dungeoneering", "Divination", "Invention", "Archaeology", "Necromancy"
];
const PERMANENT_QUEST_REWARDS = new Set([
  "crystal body", "crystal boots", "crystal gloves", "crystal helm", "crystal legs",
  "enriched pontifex shadow ring", "hand of glory (luck of the dwarves)", "helm of terror",
  "koschei's death egg", "queen mab's moonstone", "ring of solomon", "sliske's mask", "urn enhancer"
]);
const PERMANENT_COMBAT_REWARDS = [
  ["Fire cape", "Epic"],
  ["TokHaar-Kal-Ket", "Legendary"],
  ["TokHaar-Kal-Xil", "Legendary"],
  ["TokHaar-Kal-Mej", "Legendary"],
  ["Igneous Kal-Ket", "Mythic"],
  ["Igneous Kal-Xil", "Mythic"],
  ["Igneous Kal-Mej", "Mythic"],
  ["Igneous Kal-Zuk", "Godly"]
];
const PERMANENT_UTILITY_ITEMS = [
  ["Tinderbox", "Common"], ["Rake", "Common"], ["Spade", "Common"],
  ["Secateurs", "Common"], ["Magic secateurs", "Rare"], ["Gardening trowel", "Common"],
  ["Watering can", "Common"], ["Chisel", "Common"], ["Shears", "Common"],
  ["Pestle and mortar", "Common"], ["Saw", "Common"], ["Needle", "Common"],
  ["Glassblowing pipe", "Common"], ["Fishing rod", "Common"], ["Fly fishing rod", "Common"],
  ["Harpoon", "Common"], ["Small fishing net", "Common"], ["Big fishing net", "Common"]
];
const PERMANENT_CURRENCY_ITEMS = [["Coins", "Common"]];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestJson(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RuneScape-TCG-Alt1/1.0 (card catalogue generator)" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(response.headers.location).then(resolve, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", async () => {
        if (response.statusCode === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(response.headers["retry-after"]) || 2 ** attempt;
          await delay(retryAfter * 1000);
          requestJson(url, attempt + 1).then(resolve, reject);
        } else if (response.statusCode !== 200) reject(new Error(`Wiki API returned ${response.statusCode}`));
        else {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        }
      });
    }).on("error", reject);
  });
}

async function categoryMembers(category) {
  const members = [];
  let continuation = null;
  do {
    const params = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmnamespace: "0|14",
      cmtype: "page|subcat",
      cmlimit: String(PAGE_SIZE),
      format: "json",
      origin: "*"
    });
    if (continuation) params.set("cmcontinue", continuation);
    await delay(REQUEST_DELAY_MS);
    const data = await requestJson(`${API_URL}?${params}`);
    members.push(...data.query.categorymembers);
    continuation = data.continue && data.continue.cmcontinue;
  } while (continuation);
  return members;
}

async function categoryPageMembersRecursive(category, visited = new Set()) {
  const key = category.toLowerCase();
  if (visited.has(key)) return [];
  visited.add(key);

  const members = await categoryMembers(category);
  const pages = members.filter((member) => member.ns === 0);
  for (const subcategory of members.filter((member) => member.ns === 14)) {
    pages.push(...await categoryPageMembersRecursive(subcategory.title.replace(/^Category:/i, ""), visited));
  }
  return pages;
}

function isSetItemTitle(title) {
  return /\bset(?:\s+\d+)?(?:\s*\+\s*\d+|\s*\((?:lg|sk)\))?$/i.test(title);
}

function isDyedEquipmentTitle(title) {
  return /\((?:aurora|barrows|blood|dusk|ice|shadow|soul|third age|dyed)\)$/i.test(title);
}

function cleanWikiText(value) {
  return value
    .replace(/<!--.*?-->/g, "")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{(?:sic|sic\?|nbsp)\}\}/gi, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'''?|''/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExamine(wikitext) {
  const matches = [...wikitext.matchAll(/^[\t ]*\|[\t ]*examine(\d*)[\t ]*=[\t ]*([^\r\n]*)$/gim)]
    .filter((match) => cleanWikiText(match[2]));
  if (!matches.length) return "";
  const unnumbered = matches.find((match) => !match[1]);
  const selected = unnumbered || matches.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return cleanWikiText(selected[2]);
}

function extractNumberedField(wikitext, field) {
  const pattern = new RegExp(`^[\\t ]*\\|[\\t ]*${field}(\\d*)[\\t ]*=[\\t ]*([^\\r\\n]*)$`, "gim");
  const matches = [...wikitext.matchAll(pattern)];
  if (!matches.length) return "";
  const unnumbered = matches.find((match) => !match[1]);
  const selected = unnumbered || matches.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return cleanWikiText(selected[2]);
}

function numericField(wikitext, field) {
  const value = extractNumberedField(wikitext, field).replace(/,/g, "");
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Math.round(Number(match[0])) : null;
}

function maximumNumericField(wikitext, fields) {
  const names = fields.map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^[\\t ]*\\|[\\t ]*(?:${names})\\d*[\\t ]*=[\\t ]*([^\\r\\n]*)$`, "gim");
  const values = [...wikitext.matchAll(pattern)]
    .map((match) => cleanWikiText(match[1]).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/))
    .filter(Boolean)
    .map((match) => Number(match[0]));
  return values.length ? Math.max(...values) : null;
}

function highestNumberedField(wikitext, field) {
  const pattern = new RegExp(`^\\s*\\|\\s*${field}(\\d+)\\s*=`, "gim");
  const numbers = [...wikitext.matchAll(pattern)].map((match) => Number(match[1]));
  return numbers.length ? Math.max(...numbers) : null;
}

function rawField(wikitext, field) {
  const pattern = new RegExp(`^[\\t ]*\\|[\\t ]*${field}[\\t ]*=[\\t ]*([^\\r\\n]*)$`, "im");
  return (wikitext.match(pattern) || [])[1] || "";
}

function infoboxImage(title, wikitext) {
  let imageField = "";
  const names = [...wikitext.matchAll(/^[\t ]*\|[\t ]*name(\d+)[\t ]*=[\t ]*([^\r\n]*)$/gim)];
  const matchingName = names.find((match) => cleanWikiText(match[2]).toLowerCase() === title.toLowerCase());
  if (matchingName) imageField = rawField(wikitext, `image${matchingName[1]}`);
  if (!imageField) imageField = rawField(wikitext, "image") || rawField(wikitext, "image1");
  const linkedImages = [...imageField.matchAll(/\[\[(?:File:)?([^|\]]+\.(?:png|jpe?g|webp))/gi)];
  if (linkedImages.length) {
    const filename = linkedImages.at(-1)[1].replace(/ /g, "_");
    return {
      filename,
      url: `https://runescape.wiki/w/Special:Redirect/file/${encodeURIComponent(filename).replace(/'/g, "%27")}`
    };
  }
  imageField = cleanWikiText(imageField);
  const match = imageField.match(/(?:File:)?(.+?\.(?:png|jpe?g|webp))$/i);
  if (!match) return null;
  const filename = match[1].replace(/ /g, "_");
  return {
    filename,
    url: `https://runescape.wiki/w/Special:Redirect/file/${encodeURIComponent(filename).replace(/'/g, "%27")}`
  };
}

function infoboxImageUrl(title, wikitext) {
  return infoboxImage(title, wikitext)?.url || "";
}

function canonicalThumbnail(title, source, wikitext) {
  if (/\.gif(?:\?|$)/i.test(source || "")) {
    const inventoryImage = infoboxImageUrl(title, wikitext);
    if (inventoryImage) return inventoryImage;
  }
  if (!source || !/flask|potion|brew|restore|serum|antipoison|poison|overload|mix/i.test(title)) return source || "";
  const fullDose = Math.max(
    ...["examine", "image", "value", "id"].map((field) => highestNumberedField(wikitext, field) || 0)
  );
  if (!fullDose || fullDose <= 1) return source;
  return source
    .replace(/%281%29/gi, `%28${fullDose}%29`)
    .replace(/\(1\)/g, `(${fullDose})`)
    .replace(/\?.*$/, "");
}

function pageMetadata(page) {
  const content = page.revisions?.[0]?.slots?.main?.content || "";
  const inventoryImage = infoboxImage(page.title, content);
  const recipeSections = [...content.matchAll(/\{\{\s*Infobox Recipe\b([\s\S]*?)(?=\n\}\})/gi)]
    .map((match) => match[1]);
  const recipeContent = recipeSections.join("\n");
  const ingredients = [...recipeContent.matchAll(/^[\t ]*\|[\t ]*mat\d+[\t ]*=[\t ]*(.*?)[\t ]*$/gim)]
    .map((match) => cleanWikiText(match[1]))
    .filter(Boolean);
  const skills = [...recipeContent.matchAll(/^[\t ]*\|[\t ]*skill\d*[\t ]*=[\t ]*(.*?)[\t ]*$/gim)]
    .map((match) => cleanWikiText(match[1]))
    .map((value) => SKILLS.find((skill) => skill.toLowerCase() === value.toLowerCase()))
    .filter(Boolean);
  return {
    examine: extractExamine(content) || extractNumberedField(content, "desc"),
    imageUrl: canonicalThumbnail(page.title, page.thumbnail?.source, content),
    inventoryImageUrl: inventoryImage?.url || "",
    detailImageFilename: inventoryImage?.filename.replace(/\.[^.]+$/, "_detail.png") || "",
    level: numericField(content, "level"),
    value: numericField(content, "value"),
    highAlchValue: numericField(content, "highalch"),
    experience: maximumNumericField(content, ["xp", "experience"]),
    questItem: /^yes$/i.test(extractNumberedField(content, "quest")),
    tradeable: /^yes$/i.test(extractNumberedField(content, "tradeable")),
    hasRecipe: recipeSections.length > 0,
    ingredients: [...new Set(ingredients)],
    skills: [...new Set(skills)]
  };
}

async function fetchDetailImageUrls(filenames) {
  const urls = new Map();
  const unique = [...new Set(filenames.filter(Boolean))];
  for (let index = 0; index < unique.length; index += EXAMINE_BATCH_SIZE) {
    const batch = unique.slice(index, index + EXAMINE_BATCH_SIZE);
    const params = new URLSearchParams({
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      titles: batch.map((filename) => `File:${filename}`).join("|"),
      format: "json",
      formatversion: "2",
      origin: "*"
    });
    await delay(REQUEST_DELAY_MS);
    const data = await requestJson(`${API_URL}?${params}`);
    for (const page of data.query.pages || []) {
      if (page.missing || !page.imageinfo?.[0]?.url) continue;
      const key = page.title.replace(/^File:/, "").replace(/ /g, "_").toLowerCase();
      urls.set(key, page.imageinfo[0].url);
    }
  }
  return urls;
}

function skillCapeInfo(title) {
  const normalized = title.replace(/^Retro /i, "").replace(/\s*\(t\)$/i, "");
  if (/completionist cape/i.test(normalized)) return { category: "Completionist", rarity: "Godly" };
  if (/^max cape$/i.test(normalized)) return { category: "Max", rarity: "Mythic" };
  if (/^(?:Artisan's|Combatant's|Gatherer's|Support) cape$/i.test(normalized)) {
    return { category: "Accomplishment", rarity: "Legendary" };
  }
  const master = SKILLS.find((skill) => new RegExp(`^(?:master )?${skill} master cape$`, "i").test(normalized)
    || new RegExp(`^master ${skill} cape$`, "i").test(normalized));
  if (master) return { category: master, rarity: "Legendary" };
  const skill = SKILLS.find((name) => normalized.toLowerCase() === `${name.toLowerCase()} cape`);
  return skill ? { category: skill, rarity: "Epic" } : null;
}

function isCosmeticUnlockToken(card) {
  if (!card.id.startsWith("item-") || !/\btoken\b/i.test(card.name)) return false;
  if (/\bunlock(?:s|ed|ing)?\b/i.test(card.examine)) return true;
  return /\bredeem(?:ed|ing)?\b/i.test(card.examine)
    && /cosmetic|override|outfit|appearance|animation|emote|wardrobe|customisation|companion pet|mount/i.test(card.examine);
}

async function fetchGrandExchangeData() {
  const dump = await requestJson(GE_DUMP_URL);
  const byName = new Map();
  for (const entry of Object.values(dump)) {
    if (!entry || typeof entry !== "object" || !entry.name) continue;
    byName.set(String(entry.name).toLowerCase(), {
      price: Number(entry.price) || null,
      highAlchValue: Number(entry.highalch) || null
    });
  }
  return byName;
}

async function fetchCardMetadata(titles) {
  const metadata = new Map();
  for (let index = 0; index < titles.length; index += EXAMINE_BATCH_SIZE) {
    const batch = titles.slice(index, index + EXAMINE_BATCH_SIZE);
    const params = new URLSearchParams({
      action: "query",
      prop: "revisions|pageimages",
      rvprop: "content",
      rvslots: "main",
      piprop: "thumbnail",
      pithumbsize: "220",
      redirects: "1",
      titles: batch.join("|"),
      format: "json",
      formatversion: "2",
      origin: "*"
    });
    await delay(REQUEST_DELAY_MS);
    const data = await requestJson(`${API_URL}?${params}`);
    const batchMetadata = new Map();
    for (const page of data.query.pages || []) {
      batchMetadata.set(page.title, pageMetadata(page));
    }
    const aliases = new Map([
      ...(data.query.normalized || []).map(({ from, to }) => [from, to]),
      ...(data.query.redirects || []).map(({ from, to }) => [from, to])
    ]);
    for (const title of batch) {
      let resolved = title;
      const visited = new Set();
      while (aliases.has(resolved) && !visited.has(resolved)) {
        visited.add(resolved);
        resolved = aliases.get(resolved);
      }
      const pageData = batchMetadata.get(resolved) || batchMetadata.get(title);
      if (pageData) metadata.set(title, pageData);
    }
  }
  return metadata;
}

async function collectSource(source) {
  const pages = [];
  const queue = [source.category];
  const visited = new Set();
  while (queue.length) {
    const category = queue.shift();
    if (visited.has(category)) continue;
    visited.add(category);
    const members = await categoryMembers(category);
    for (const member of members) {
      if (member.ns === 0) pages.push({ title: member.title, category });
      else if (source.recursive) queue.push(member.title.replace(/^Category:/, ""));
    }
  }
  return pages;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function canonicalItemTitle(title, availableTitles) {
  const candidates = [];
  const consumable = /potion|brew|serum|antipoison|poison|overload|flask|cake|pie|pizza|jellyfish/i.test(title);
  if (consumable) {
    candidates.push(title.replace(/\s*\((?:[1-6]|[1-6]\/[1-6])\)$/, ""));
    candidates.push(title.replace(/^Half (?:a|an) /i, ""));
    candidates.push(title.replace(/^Slice of /i, ""));
    candidates.push(title.replace(/ slice$/i, ""));
  }
  candidates.push(title.replace(/\s*\((?:empty|full|lit|unlit|charged|uncharged|partially eaten)\)$/i, ""));
  return candidates.find((candidate) => candidate !== title && availableTitles.has(candidate.toLowerCase())) || title;
}

function collapseItemVariants(pages) {
  const availableTitles = new Set(pages.map((page) => page.title.toLowerCase()));
  const canonicalPages = new Map();
  for (const page of pages) {
    const canonicalTitle = canonicalItemTitle(page.title, availableTitles);
    const existing = canonicalPages.get(canonicalTitle.toLowerCase());
    if (!existing || page.title === canonicalTitle) {
      canonicalPages.set(canonicalTitle.toLowerCase(), { ...page, title: canonicalTitle, wikiTitle: canonicalTitle });
    }
  }
  const collapsed = [...canonicalPages.values()];
  const collapsedTitles = new Set(collapsed.map((page) => page.title.toLowerCase()));
  return collapsed.filter((page) => {
    const canonical = canonicalBaseTitle(page.title);
    return canonical === page.title.toLowerCase() || !collapsedTitles.has(canonical);
  });
}

function collapseNpcVariants(pages) {
  const titles = new Set(pages.map((page) => page.title.toLowerCase()));
  return pages.filter((page) => {
    const canonical = page.title.replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)?\)$/, "").toLowerCase();
    return canonical === page.title.toLowerCase() || !titles.has(canonical);
  });
}

function isNicheNpcTitle(title) {
  return /\((?:unused|historical|removed|teaser|cutscene|tutorial|player-owned house(?:, historical)?|\d{4} (?:halloween|christmas|easter) event)\)$/i.test(title);
}

function isTemporaryQuestItem(card) {
  return card.questItem && !PERMANENT_QUEST_REWARDS.has(card.name.toLowerCase());
}

function cardScore(card) {
  const valueScore = Number(card.value) || 0;
  const experienceScore = (Number(card.experience) || 0) * XP_SCORE_MULTIPLIER;
  const level = Number(card.level) || 0;
  const levelScore = card.overrideScore === null
    ? level ** 2 * (card.category.includes("NPC") ? 1.5 : 1)
    : Math.max(0, Number(card.overrideScore) || 0);
  return Math.max(valueScore + experienceScore, levelScore);
}

function tierForPercentile(percentile) {
  if (percentile >= 0.98) return "Godly";
  if (percentile >= 0.95) return "Mythic";
  if (percentile >= 0.90) return "Legendary";
  if (percentile >= 0.75) return "Epic";
  if (percentile >= 0.50) return "Rare";
  if (percentile >= 0.25) return "Uncommon";
  return "Common";
}

function bestTier(first, second) {
  return TIERS[Math.max(TIERS.indexOf(first), TIERS.indexOf(second))];
}

function assignRarities(cards) {
  const groups = new Map();
  for (const card of cards) {
    const primary = card.category[0] || "Unknown";
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push(card);
  }

  for (const group of groups.values()) {
    const tiering = group.filter((card) => cardScore(card) > 1)
      .sort((a, b) => cardScore(a) - cardScore(b));
    tiering.forEach((card, index) => {
      const percentile = tiering.length === 1 ? 1 : index / (tiering.length - 1);
      card.rarity = tierForPercentile(percentile);
    });
    group.filter((card) => cardScore(card) <= 1).forEach((card) => { card.rarity = "Common"; });

    const bestByValue = new Map();
    const bestByScore = new Map();
    for (const card of tiering) {
      if (card.value !== null) bestByValue.set(card.value, bestTier(bestByValue.get(card.value) || "Common", card.rarity));
      const score = Math.round(cardScore(card));
      bestByScore.set(score, bestTier(bestByScore.get(score) || "Common", card.rarity));
    }
    for (const card of tiering) {
      if (card.value !== null) card.rarity = bestTier(card.rarity, bestByValue.get(card.value));
      card.rarity = bestTier(card.rarity, bestByScore.get(Math.round(cardScore(card))));
    }
  }

  const globalBestByValue = new Map();
  for (const card of cards) {
    if (card.value !== null && card.value !== 0 && card.value !== 1) {
      globalBestByValue.set(card.value, bestTier(globalBestByValue.get(card.value) || "Common", card.rarity));
    }
  }
  for (const card of cards) {
    if (cardScore(card) <= 1) card.rarity = "Common";
    else if (card.value !== null) card.rarity = bestTier(card.rarity, globalBestByValue.get(card.value));
    if (card.minimumRarity) card.rarity = bestTier(card.rarity, card.minimumRarity);
  }
}

async function main() {
  const cards = [];
  process.stdout.write("Fetching Grand Exchange prices... ");
  const grandExchangeData = await fetchGrandExchangeData();
  console.log(`${grandExchangeData.size} priced items`);
  process.stdout.write("Fetching Grand Exchange set exclusions... ");
  const grandExchangeSets = new Set(
    (await categoryPageMembersRecursive("Grand Exchange sets"))
      .map((member) => member.title.toLowerCase())
  );
  console.log(`${grandExchangeSets.size} exclusions`);
  process.stdout.write("Fetching dyed equipment exclusions... ");
  const dyedEquipment = new Set(
    (await categoryPageMembersRecursive("Dyed equipment"))
      .map((member) => member.title.toLowerCase())
  );
  console.log(`${dyedEquipment.size} exclusions`);
  process.stdout.write("Fetching CoinShare shard exclusions... ");
  const coinShareShards = new Set(
    (await categoryMembers("Item shards"))
      .filter((member) => member.ns === 0)
      .map((member) => member.title.toLowerCase())
  );
  console.log(`${coinShareShards.size} exclusions`);
  process.stdout.write("Fetching Summoning familiar exclusions... ");
  const summoningFamiliars = new Set(
    (await categoryMembers("Familiars"))
      .filter((member) => member.ns === 0)
      .map((member) => member.title.toLowerCase())
  );
  console.log(`${summoningFamiliars.size} exclusions`);
  for (const source of SOURCES) {
    process.stdout.write(`Fetching ${source.category}... `);
    const pages = await collectSource(source);
    const allowedPages = pages.filter((page) => {
      const title = page.title.toLowerCase();
      return !grandExchangeSets.has(title)
        && !isSetItemTitle(page.title)
        && !dyedEquipment.has(title)
        && !isDyedEquipmentTitle(page.title)
        && !coinShareShards.has(title)
        && !(source.kind === "npc" && summoningFamiliars.has(title));
    });
    const sourcePages = source.kind === "item" && !source.preserveVariants
      ? collapseItemVariants(allowedPages)
      : source.kind === "npc"
        ? collapseNpcVariants(allowedPages).filter((page) => !isNicheNpcTitle(page.title))
        : allowedPages;
    const unique = new Map(sourcePages.map((page) => [page.title, page]));
    for (const page of unique.values()) {
      const level = (page.category.match(/Combat level (\d+)/) || [])[1];
      cards.push({
        id: `${source.kind}-${slug(page.title)}-${hash(page.title).toString(36)}`,
        name: page.title,
        category: [...source.tags],
        imageUrl: "",
        level: source.kind === "npc" && level ? Number(level) : null,
        value: null,
        geValue: null,
        highAlchValue: null,
        experience: null,
        overrideScore: null,
        examine: level ? `A RuneScape combatant with combat level ${level}.` : `A RuneScape ${source.tags.join(" ").toLowerCase()}.`,
        questItem: false,
        rarity: "Common",
        wikiTitle: page.wikiTitle || page.title,
        recipeCandidate: Boolean(source.recipeCandidates)
      });
    }
    console.log(`${unique.size} cards`);
  }
  for (const [title, minimumRarity] of PERMANENT_COMBAT_REWARDS) {
    cards.push({
      id: `item-${slug(title)}-${hash(title).toString(36)}`,
      name: title,
      category: ["Resource", "Accomplishment"],
      imageUrl: "",
      level: null,
      value: null,
      geValue: null,
      highAlchValue: null,
      experience: null,
      overrideScore: null,
      examine: "A permanent combat accomplishment reward.",
      questItem: false,
      rarity: minimumRarity,
      minimumRarity,
      wikiTitle: title,
      recipeCandidate: false
    });
  }
  for (const [title, minimumRarity] of PERMANENT_UTILITY_ITEMS) {
    cards.push({
      id: `item-${slug(title)}-${hash(title).toString(36)}`,
      name: title,
      category: ["Resource", "Tool"],
      imageUrl: "",
      level: null,
      value: null,
      geValue: null,
      highAlchValue: null,
      experience: null,
      overrideScore: null,
      examine: "A useful RuneScape tool.",
      questItem: false,
      rarity: minimumRarity,
      minimumRarity,
      wikiTitle: title,
      recipeCandidate: false
    });
  }
  for (const [title, minimumRarity] of PERMANENT_CURRENCY_ITEMS) {
    cards.push({
      id: `item-${slug(title)}-${hash(title).toString(36)}`,
      name: title,
      category: ["Resource", "Currency"],
      imageUrl: "",
      level: null,
      value: 1,
      geValue: null,
      highAlchValue: null,
      experience: null,
      overrideScore: null,
      examine: "Lovely money!",
      questItem: false,
      rarity: minimumRarity,
      minimumRarity,
      wikiTitle: title,
      recipeCandidate: false
    });
  }
  const byId = new Map();
  for (const card of cards) {
    const existing = byId.get(card.id);
    if (!existing || card.minimumRarity || (existing.recipeCandidate && !card.recipeCandidate)) byId.set(card.id, card);
  }
  let deduplicated = [...byId.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.category.join().localeCompare(b.category.join()));
  process.stdout.write(`Fetching Wiki metadata for ${deduplicated.length} cards... `);
  const wikiTitles = [...new Set(deduplicated.map((card) => card.wikiTitle))];
  const metadata = await fetchCardMetadata(wikiTitles);
  process.stdout.write("fetching item detail images... ");
  const detailImageUrls = await fetchDetailImageUrls(
    deduplicated
      .filter((card) => card.id.startsWith("item-"))
      .map((card) => metadata.get(card.wikiTitle)?.detailImageFilename)
  );
  console.log(`${detailImageUrls.size} detail images found`);
  let examineCount = 0;
  for (const card of deduplicated) {
    const pageData = metadata.get(card.wikiTitle);
    if (!pageData) continue;
    if (pageData.examine) {
      card.examine = pageData.examine;
      examineCount += 1;
    }
    card.imageUrl = pageData.imageUrl;
    card.questItem = pageData.questItem;
    if (card.id.startsWith("item-")) {
      card.imageUrl = detailImageUrls.get(pageData.detailImageFilename.toLowerCase())
        || pageData.inventoryImageUrl
        || pageData.imageUrl;
      const exchange = grandExchangeData.get(card.name.toLowerCase());
      card.geValue = exchange?.price || null;
      card.highAlchValue = exchange?.highAlchValue || pageData.highAlchValue;
      card.experience = pageData.experience;
      card.value = Math.max(card.geValue || 0, card.highAlchValue || 0, pageData.value || 0) || null;
    } else if (!card.category.includes("NPC")) card.level = pageData.level;
    if (card.recipeCandidate && pageData.hasRecipe) {
      card.category[1] = pageData.skills[0] || "Skill-created Item";
    }
    const cape = skillCapeInfo(card.name);
    if (cape) {
      card.category[1] = cape.category;
      card.minimumRarity = cape.rarity;
    }
  }
  const recipeCards = deduplicated.filter((card) => card.recipeCandidate && metadata.get(card.wikiTitle)?.hasRecipe);
  const candidateTitles = new Set(
    deduplicated.filter((card) => card.recipeCandidate).map((card) => card.name.toLowerCase())
  );
  const ingredientTitles = new Set();
  for (const card of recipeCards) {
    for (const ingredient of metadata.get(card.wikiTitle).ingredients) {
      ingredientTitles.add(canonicalItemTitle(ingredient, candidateTitles).toLowerCase());
    }
  }
  deduplicated = deduplicated.filter((card) => {
    if (!card.recipeCandidate) return true;
    const pageData = metadata.get(card.wikiTitle);
    return pageData && !pageData.tradeable
      && (pageData.hasRecipe || ingredientTitles.has(card.name.toLowerCase()));
  });
  const beforeCosmeticTokens = deduplicated.length;
  deduplicated = deduplicated.filter((card) => !isCosmeticUnlockToken(card));
  console.log(`${beforeCosmeticTokens - deduplicated.length} cosmetic unlock tokens excluded`);
  const beforeTemporaryQuestItems = deduplicated.length;
  deduplicated = deduplicated.filter((card) => !isTemporaryQuestItem(card));
  console.log(`${beforeTemporaryQuestItems - deduplicated.length} temporary quest items excluded`);
  deduplicated.forEach((card) => { delete card.recipeCandidate; });
  assignRarities(deduplicated);
  const beforeEligibility = deduplicated.length;
  deduplicated = deduplicated.filter((card) => !isOverviewCard(card)
    && (!card.id.startsWith("item-") || isEligibleItem(card)));
  console.log(`${beforeEligibility - deduplicated.length} low-impact item cards excluded`);
  deduplicated.forEach((card) => {
    card.sourceValue = cardSourceValue(card);
    card.value = cardCreditValue(card, card.sourceValue);
    delete card.minimumRarity;
  });
  console.log(`${examineCount} examine texts found`);
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(deduplicated, null, 2)}\n`);
  console.log(`Wrote ${deduplicated.length} cards to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
