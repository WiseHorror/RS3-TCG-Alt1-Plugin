const fs = require("fs");
const path = require("path");
const https = require("https");

const API_URL = "https://runescape.wiki/api.php";
const OUTPUT_PATH = path.join(__dirname, "..", "src", "player-titles.json");
const USER_AGENT = "RuneScape-TCG-Alt1/1.0 (player title catalogue)";

function api(params) {
  const url = new URL(API_URL);
  Object.entries({ format: "json", formatversion: "2", ...params }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Wiki API returned ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

async function getTitlePageNames() {
  const names = [];
  let cmcontinue = "";
  do {
    const data = await api({
      action: "query",
      list: "categorymembers",
      cmtitle: "Category:Titles",
      cmnamespace: "0",
      cmlimit: "max",
      ...(cmcontinue ? { cmcontinue } : {})
    });
    names.push(...data.query.categorymembers.map((page) => page.title));
    cmcontinue = data.continue?.cmcontinue || "";
  } while (cmcontinue);
  return names;
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTitlePage(wikitext) {
  const infobox = wikitext.match(/\{\{Infobox Title\b([\s\S]*?)\n\}\}/i)?.[1];
  if (!infobox) return [];
  const position = infobox.match(/^\s*\|\s*position\s*=\s*([^\n]+)/im)?.[1].trim().toLowerCase();
  if (position !== "prefix" && position !== "suffix") return [];

  const values = [];
  const anchorPattern = /\{\{TitleAnchor\b([\s\S]*?)\}\}/gi;
  for (const anchor of infobox.matchAll(anchorPattern)) {
    const value = anchor[1].match(/(?:^|\|)\s*t\s*=\s*([^|}]+)/i)?.[1];
    if (value && !value.includes("{{")) values.push(cleanTitle(value));
  }
  if (!values.length) {
    const namePattern = /^\s*\|\s*name\d*\s*=\s*([^\n]+)/gim;
    for (const match of infobox.matchAll(namePattern)) values.push(cleanTitle(match[1]));
  }
  return [...new Set(values.filter(Boolean))].map((title) => ({ title, position }));
}

async function main() {
  const names = await getTitlePageNames();
  const titles = [];
  for (let index = 0; index < names.length; index += 50) {
    const data = await api({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: names.slice(index, index + 50).join("|")
    });
    for (const page of data.query.pages) {
      const text = page.revisions?.[0]?.slots?.main?.content || "";
      titles.push(...parseTitlePage(text));
    }
  }
  const unique = [...new Map(titles.map((entry) => [`${entry.position}:${entry.title.toLowerCase()}`, entry])).values()]
    .sort((a, b) => a.position.localeCompare(b.position) || a.title.localeCompare(b.title));
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(unique, null, 2)}\n`);
  console.log(`Wrote ${unique.length} player titles to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
