const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const API = "https://runescape.wiki/api.php";
const cataloguePath = path.resolve(__dirname, "../src/generated-cards.json");

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RuneScape-TCG-Alt1/1.0 (image audit)" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) reject(new Error(`Wiki API returned ${response.statusCode}`));
        else try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

async function pageData(titles) {
  const pages = new Map();
  for (let index = 0; index < titles.length; index += 40) {
    const batch = titles.slice(index, index + 40);
    const params = new URLSearchParams({
      action: "query", prop: "revisions|pageimages", rvprop: "content", rvslots: "main",
      piprop: "thumbnail", pithumbsize: "500", redirects: "1", titles: batch.join("|"),
      format: "json", formatversion: "2"
    });
    const data = await requestJson(`${API}?${params}`);
    const aliases = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])]
      .map(({ from, to }) => [from, to]));
    const byTitle = new Map(data.query.pages.map((page) => [page.title, page]));
    for (const title of batch) {
      let resolved = title;
      while (aliases.has(resolved)) resolved = aliases.get(resolved);
      const page = byTitle.get(resolved) || byTitle.get(title);
      pages.set(title, {
        imageUrl: page?.thumbnail?.source || "",
        wikitext: page?.revisions?.[0]?.slots?.main?.content || ""
      });
    }
  }
  return pages;
}

function infoboxImage(wikitext) {
  const value = wikitext.match(/^\s*\|\s*image(?:1)?\s*=\s*([^\r\n]+)/im)?.[1] || "";
  return value.replace(/^\[\[(?:File|Image):/i, "").replace(/\|.*|\]\].*/g, "").trim();
}

async function fileUrls(filenames) {
  const urls = new Map();
  const unique = [...new Set(filenames.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 40) {
    const batch = unique.slice(index, index + 40);
    const params = new URLSearchParams({
      action: "query", prop: "imageinfo", iiprop: "url", iiurlwidth: "500",
      titles: batch.map((name) => `File:${name}`).join("|"), format: "json", formatversion: "2"
    });
    const data = await requestJson(`${API}?${params}`);
    for (const page of data.query.pages) {
      if (!page.missing && page.imageinfo?.[0]) {
        urls.set(page.title.replace(/^File:/, ""), page.imageinfo[0].thumburl || page.imageinfo[0].url);
      }
    }
  }
  return urls;
}

function isConcreteCard(card, wikitext) {
  if (card.id.startsWith("item-")) return /\{\{\s*Infobox Item\b/i.test(wikitext);
  if (card.id.startsWith("npc-")) return /\{\{\s*Infobox (?:Monster|NPC)\b/i.test(wikitext);
  return /\{\{\s*Infobox (?:scenery|resource|hotspot|tree|rock|fishing spot)\b/i.test(wikitext)
    || /\|\s*(?:level|required level|skill)\s*=/i.test(wikitext);
}

async function main() {
  const cards = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  const missing = cards.filter((card) => !String(card.imageUrl || "").trim());
  const wiki = await pageData([...new Set(missing.map((card) => card.wikiTitle))]);
  const candidates = new Map();
  for (const card of missing) {
    const page = wiki.get(card.wikiTitle) || { wikitext: "" };
    const names = [infoboxImage(page.wikitext)];
    if (card.id.startsWith("item-")) names.push(`${card.wikiTitle.replace(/ /g, "_")}_detail.png`);
    candidates.set(card.id, names.filter(Boolean));
  }
  const images = await fileUrls([...candidates.values()].flat());
  const removed = [];
  let restored = 0;
  const audited = cards.filter((card) => {
    if (String(card.imageUrl || "").trim()) return true;
    const page = wiki.get(card.wikiTitle) || { imageUrl: "", wikitext: "" };
    const fallbackImage = candidates.get(card.id)?.map((name) => images.get(name)).find(Boolean);
    if (page.imageUrl || fallbackImage) {
      card.imageUrl = page.imageUrl || fallbackImage;
      restored += 1;
      return true;
    }
    if (isConcreteCard(card, page.wikitext)) return true;
    removed.push(card.name);
    return false;
  });
  await fs.writeFile(cataloguePath, `${JSON.stringify(audited, null, 2)}\n`);
  console.log(`Missing before: ${missing.length}; images restored: ${restored}; abstract cards removed: ${removed.length}.`);
  removed.forEach((name) => console.log(`- ${name}`));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
