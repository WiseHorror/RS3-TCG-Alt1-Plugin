// Destructive final curation pass. Review the generated-cards.json diff after
// running this script and before committing it.
const fs = require("fs");
const path = require("path");
const {
  canonicalBaseTitle,
  isAugmentedItemVariant,
  isConstructionBanner,
  isConstructionFurniture,
  isExpertSkillcapeShard,
  isGrandExchangeSet,
  isEligibleItem,
  isLootPinataItem,
  isOverviewCard,
  isRedundantSkillcapeVariant,
  isTitleScroll
} = require("./card-eligibility");

const cataloguePath = path.resolve(__dirname, "../src/generated-cards.json");
const permanentQuestRewards = new Set([
  "crystal body", "crystal boots", "crystal gloves", "crystal helm", "crystal legs",
  "enriched pontifex shadow ring", "hand of glory (luck of the dwarves)", "helm of terror",
  "koschei's death egg", "queen mab's moonstone", "ring of solomon", "sliske's mask", "urn enhancer"
]);

const cards = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
const npcTitles = new Set(cards.filter((card) => card.category.includes("NPC")).map((card) => card.name.toLowerCase()));
const itemTitles = new Set(cards.filter((card) => card.id.startsWith("item-")).map((card) => card.name.toLowerCase()));
const isNicheNpc = (title) => /\((?:unused|historical|removed|teaser|cutscene|tutorial|player-owned house(?:, historical)?|\d{4} (?:halloween|christmas|easter) event)\)$/i.test(title);

function exclusionReason(card) {
  // A reason string keeps removal reports auditable while remaining truthy.
  if (isOverviewCard(card)) return "overview page";
  if (isConstructionBanner(card)) return "construction banner";
  if (isConstructionFurniture(card)) return "construction furniture";
  if (isGrandExchangeSet(card)) return "Grand Exchange set";
  if (isExpertSkillcapeShard(card)) return "expert skillcape shard";
  if (isLootPinataItem(card)) return "Loot Pinata item";
  if (isTitleScroll(card)) return "title scroll";
  if (card.category.includes("NPC")) {
    const canonical = canonicalBaseTitle(card.name);
    if (canonical !== card.name.toLowerCase() && npcTitles.has(canonical)) return "duplicate NPC";
    if (isNicheNpc(card.name)) return "niche NPC";
  }
  if (card.questItem && !permanentQuestRewards.has(card.name.toLowerCase())) return "temporary quest item";
  if (card.id.startsWith("item-")) {
    if (isAugmentedItemVariant(card)) return "augmented item variant";
    if (isRedundantSkillcapeVariant(card)) return "redundant skillcape variant";
    const canonical = canonicalBaseTitle(card.name);
    if (!card.category.includes("Clue Reward")
      && canonical !== card.name.toLowerCase() && itemTitles.has(canonical)) return "duplicate item variant";
    if (!isEligibleItem(card)) return "low-impact item";
  }
  return "";
}

const counts = {};
const curated = cards.filter((card) => {
  const reason = exclusionReason(card);
  if (!reason) return true;
  counts[reason] = (counts[reason] || 0) + 1;
  return false;
});

fs.writeFileSync(cataloguePath, `${JSON.stringify(curated, null, 2)}\n`);
console.log(`Removed ${cards.length - curated.length} cards; ${curated.length} remain.`);
for (const [reason, count] of Object.entries(counts)) console.log(`- ${reason}: ${count}`);
