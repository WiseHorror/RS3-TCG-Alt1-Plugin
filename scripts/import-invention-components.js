const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const API_URL = "https://runescape.wiki/api.php";
const cataloguePath = path.resolve(__dirname, "../src/generated-cards.json");
const { cardCreditValue, cardSourceValue } = require("./card-value");

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RuneScape-TCG-Alt1/1.0 (component importer)" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) reject(new Error(`Wiki API returned ${response.statusCode}`));
        else {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        }
      });
    }).on("error", reject);
  });
}

function field(wikitext, name) {
  const match = wikitext.match(new RegExp(`^[\\t ]*\\|[\\t ]*${name}[\\t ]*=[\\t ]*([^\\r\\n]*)$`, "im"));
  return (match?.[1] || "").replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]*\}/g, "").replace(/<[^>]+>/g, "").replace(/'''?|''/g, "").replace(/\s+/g, " ").trim();
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

async function main() {
  const memberParams = new URLSearchParams({
    action: "query", list: "categorymembers", cmtitle: "Category:Materials", cmnamespace: "0",
    cmlimit: "500", format: "json", formatversion: "2"
  });
  const memberData = await requestJson(`${API_URL}?${memberParams}`);
  const titles = memberData.query.categorymembers.map((member) => member.title).filter((title) => title !== "Materials");
  const metadata = new Map();
  for (let index = 0; index < titles.length; index += 40) {
    const batch = titles.slice(index, index + 40);
    const params = new URLSearchParams({
      action: "query", prop: "revisions|pageimages", rvprop: "content", rvslots: "main",
      piprop: "thumbnail", pithumbsize: "220", titles: batch.join("|"), format: "json", formatversion: "2"
    });
    const data = await requestJson(`${API_URL}?${params}`);
    for (const page of data.query.pages) {
      const wikitext = page.revisions?.[0]?.slots?.main?.content || "";
      if (!/\{\{\s*Infobox Material\b/i.test(wikitext)) continue;
      metadata.set(page.title, {
        description: field(wikitext, "desc"), level: Number(field(wikitext, "level")) || null,
        experience: Number(field(wikitext, "xp")) || null, materialRarity: field(wikitext, "rarity"),
        imageUrl: page.thumbnail?.source || ""
      });
    }
  }
  const cards = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  const cardRarity = { Common: "Common", Uncommon: "Rare", Rare: "Epic" };
  let added = 0;
  for (const title of titles) {
    if (cards.some((card) => card.name.toLowerCase() === title.toLowerCase())) continue;
    const page = metadata.get(title);
    if (!page) continue;
    const rarity = cardRarity[page.materialRarity] || "Common";
    const card = {
      id: `component-${slug(title)}-${hash(title).toString(36)}`, name: title,
      category: ["Resource", "Invention Component"], imageUrl: page.imageUrl, level: page.level,
      value: 0, geValue: null, highAlchValue: null,
      experience: page.experience, overrideScore: null, examine: page.description || "An Invention material.",
      questItem: false, rarity, wikiTitle: title
    };
    card.sourceValue = cardSourceValue(card);
    card.value = cardCreditValue(card, card.sourceValue);
    cards.push(card);
    added += 1;
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(cataloguePath, `${JSON.stringify(cards, null, 2)}\n`);
  console.log(`Added ${added} Invention material cards; ${cards.length} total cards.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
