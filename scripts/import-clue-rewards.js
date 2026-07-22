// Supplements the catalogue with a Wiki item category that broad item curation
// could otherwise omit. Defaults to clue rewards, but accepts a category and
// card tag as command-line arguments.
const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const API_URL = "https://runescape.wiki/api.php";
const GE_DUMP_URL = "https://chisel.weirdgloop.org/gazproj/gazbot/rs_dump.json";
const cataloguePath = path.resolve(__dirname, "../src/generated-cards.json");
const sourceCategory = process.argv[2] || "Treasure Trails rewards";
const cardTag = process.argv[3] || "Clue Reward";
const explicitTitles = process.argv[4] ? process.argv[4].split("|").map((title) => title.trim()).filter(Boolean) : null;
const {
  isAugmentedItemVariant,
  isGrandExchangeSet,
  isLootPinataItem,
  isRedundantSkillcapeVariant
} = require("./card-eligibility");
const { cardCreditValue, cardSourceValue } = require("./card-value");

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RuneScape-TCG-Alt1/1.0 (clue reward importer)" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(response.headers.location).then(resolve, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) reject(new Error(`Request returned ${response.statusCode}`));
        else {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        }
      });
    }).on("error", reject);
  });
}

async function categoryMembers(category) {
  const members = [];
  let continuation = "";
  do {
    const params = new URLSearchParams({
      action: "query", list: "categorymembers", cmtitle: `Category:${category}`,
      cmnamespace: "0|14", cmtype: "page|subcat", cmlimit: "500", format: "json", formatversion: "2"
    });
    if (continuation) params.set("cmcontinue", continuation);
    const data = await requestJson(`${API_URL}?${params}`);
    members.push(...data.query.categorymembers);
    continuation = data.continue?.cmcontinue || "";
  } while (continuation);
  return members;
}

async function categoryPageMembersRecursive(category, visited = new Set()) {
  // Reward categories may divide their items among nested tiers and types.
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

function cleanWikiText(value = "") {
  return value.replace(/<!--.*?-->/g, "").replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1").replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "").replace(/'''?|''/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function numberedField(wikitext, field) {
  const pattern = new RegExp(`^[\\t ]*\\|[\\t ]*${field}(\\d*)[\\t ]*=[\\t ]*([^\\r\\n]*)$`, "gim");
  const matches = [...wikitext.matchAll(pattern)];
  const match = matches.find((entry) => !entry[1]) || matches.at(-1);
  return cleanWikiText(match?.[2]);
}

function numberField(wikitext, field) {
  const match = numberedField(wikitext, field).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function fetchMetadata(titles) {
  const metadata = new Map();
  for (let index = 0; index < titles.length; index += 40) {
    const batch = titles.slice(index, index + 40);
    const params = new URLSearchParams({
      action: "query", prop: "revisions|pageimages", rvprop: "content", rvslots: "main",
      piprop: "thumbnail", pithumbsize: "220", redirects: "1", titles: batch.join("|"),
      format: "json", formatversion: "2"
    });
    const data = await requestJson(`${API_URL}?${params}`);
    const byTitle = new Map(data.query.pages.map((page) => [page.title, page]));
    const aliases = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])].map(({ from, to }) => [from, to]));
    for (const title of batch) {
      let resolved = title;
      const visited = new Set();
      while (aliases.has(resolved) && !visited.has(resolved)) {
        visited.add(resolved);
        resolved = aliases.get(resolved);
      }
      const page = byTitle.get(resolved) || byTitle.get(title);
      const wikitext = page?.revisions?.[0]?.slots?.main?.content || "";
      if (!/\{\{\s*Infobox Item\b/i.test(wikitext)) continue;
      metadata.set(title, {
        examine: numberedField(wikitext, "examine"), imageUrl: page?.thumbnail?.source || "",
        value: numberField(wikitext, "value"), highAlchValue: numberField(wikitext, "highalch")
      });
    }
  }
  return metadata;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function rarityForValue(value, sortedValues) {
  // Rank rewards against one another so tiers adapt as GE prices change.
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedValues[middle] <= value) low = middle + 1;
    else high = middle;
  }
  const percentile = sortedValues.length ? low / sortedValues.length : 0;
  if (percentile >= 0.98) return "Godly";
  if (percentile >= 0.95) return "Mythic";
  if (percentile >= 0.90) return "Legendary";
  if (percentile >= 0.75) return "Epic";
  if (percentile >= 0.50) return "Rare";
  if (percentile >= 0.25) return "Uncommon";
  return "Common";
}

async function main() {
  const cards = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  const members = explicitTitles ? [] : await categoryPageMembersRecursive(sourceCategory);
  const titles = explicitTitles || [...new Set(members.map((member) => member.title))];
  const [metadata, geDump] = await Promise.all([fetchMetadata(titles), requestJson(GE_DUMP_URL)]);
  const exchange = new Map(Object.values(geDump).filter((entry) => entry?.name).map((entry) => [entry.name.toLowerCase(), entry]));
  const sortedValues = cards.filter((card) => card.id.startsWith("item-")).map((card) => Number(card.value) || 0).sort((a, b) => a - b);
  let added = 0;
  let updated = 0;
  for (const title of titles) {
    const page = metadata.get(title);
    if (!page) continue;
    const candidate = { name: title, category: ["Resource", cardTag] };
    if (isAugmentedItemVariant(candidate) || isGrandExchangeSet(candidate)
      || isLootPinataItem(candidate) || isRedundantSkillcapeVariant(candidate)) continue;
    const existing = cards.find((card) => card.name.toLowerCase() === title.toLowerCase());
    if (existing) {
      if (!existing.category.includes(cardTag)) existing.category.push(cardTag);
      updated += 1;
      continue;
    }
    const ge = exchange.get(title.toLowerCase());
    const value = Math.max(Number(ge?.price) || 0, Number(ge?.highalch) || 0, page.highAlchValue || 0, page.value || 0);
    const rarity = rarityForValue(value, sortedValues);
    const card = {
      id: `item-${slug(title)}-${hash(title).toString(36)}`, name: title,
      category: ["Resource", cardTag], imageUrl: page.imageUrl, level: null,
      value, geValue: Number(ge?.price) || null,
      highAlchValue: Number(ge?.highalch) || page.highAlchValue, experience: null, overrideScore: null,
      examine: page.examine || `A reward from ${sourceCategory}.`, questItem: false, rarity, wikiTitle: title
    };
    card.sourceValue = cardSourceValue(card);
    card.value = cardCreditValue(card, card.sourceValue);
    cards.push(card);
    added += 1;
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(cataloguePath, `${JSON.stringify(cards, null, 2)}\n`);
  console.log(`${sourceCategory} pages: ${titles.length}; added: ${added}; existing tagged: ${updated}; total cards: ${cards.length}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
