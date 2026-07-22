// Shared curation rules for deciding whether an item is useful in a practical
// TCG-locked RuneScape progression catalogue.
const HIGH_RARITIES = new Set(["Epic", "Legendary", "Mythic", "Godly"]);
// This broad vocabulary keeps recognizable resources, equipment, consumables,
// and tools while allowing low-impact incidental items to be removed.
const CORE_ITEM_PATTERN = /\b(?:ore|bar|logs?|planks?|wood|stone|clay|sand|glass|hide|leather|cloth|wool|flax|herb|seed|spore|compost|rune|essence|bones?|ashes|charm|energy|charge|fish|shark|lobster|salmon|trout|tuna|swordfish|bread|cake|pie|pizza|potion|overload|brew|restore|antipoison|serum|flask|jellyfish|soup|meat|arrow|arrowheads|bolts?|dart|knife|javelin|bow|crossbow|staff|wand|orb|sword|scimitar|dagger|mace|axe|hatchet|pickaxe|spear|halberd|whip|maul|hammer|tinderbox|rake|spade|secateurs|trowel|dibber|watering can|chisel|shears|pestle and mortar|saw|needle|glassblowing pipe|fishing rod|fishing net|lobster pot|harpoon|shield|defender|repriser|rebounder|armour|armor|helm|hood|hat|body|platebody|chainbody|legs|platelegs|skirt|plateskirt|boots|gloves|gauntlets|cape|ring|amulet|necklace|bracelet|relic|codex|blueprint|scrimshaw|sign|portent|pouch|scroll|tablet|talisman|tiara|urn|incense|cannonball|nails?|component|gizmo|augmentor|siphon|necroplasm|synapse|sinew|soil|sediment|gravel|salt)\b/i;
const LOOT_PINATA_ITEMS = new Set([
  "loot pinata", "pinata loot bag", "pinata sombrero", "pinata plushie", "luchador mask token"
]);
const SKILLING_OUTFIT_NAME = /^(?:nimble|archaeologist's|constructor's|sous chef's|artisan's|diviner's|farmer's|fishing|fletcher's|botanist's|hunter's|golden mining|ritualist's|first age|master runecrafter|blacksmith's|shaman's|black ibis|lumberjack|master camouflage|elder divination|master farmer|magic golem|nature's sentinel|fury shark|master constructor's|master archaeologist's)\b/i;

function normalizedName(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function canonicalBaseTitle(title) {
  return title.replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)?\)$/, "").toLowerCase();
}

function isRedundantSkillcapeVariant(card) {
  return /^inverted (?:hooded )?.*\bcape$/i.test(card.name)
    || /^inverted skillcapes$/i.test(card.name)
    || /^hooded .*\bcape$/i.test(card.name)
    || (/ hood$/i.test(card.name) && card.category.includes("Accomplishment"));
}

function isOverviewCard(card) {
  return /^(?:cape \(emote\)|capes of accomplishment|expert capes of accomplishment|master capes of accomplishment|materials|rocks|trees|wisps|excavation hotspots|fishing spot)$/i.test(card.name);
}

function isAugmentedItemVariant(card) {
  return /^augmented\b/i.test(card.name);
}

function isGrandExchangeSet(card) {
  return /\bset(?:\s+\d+)?(?:\s*\+\s*\d+|\s*\((?:lg|sk)\))?$/i.test(card.name);
}

function isLootPinataItem(card) {
  return LOOT_PINATA_ITEMS.has(normalizedName(card.name));
}

function isExpertSkillcapeShard(card) {
  return /combined with others to create a magical cape/i.test(card.examine || "");
}

function isTitleScroll(card) {
  return /\btitle scroll\b/i.test(card.name);
}

function isSkillingOutfitItem(card) {
  return SKILLING_OUTFIT_NAME.test(card.name)
    || /(?:outfit|skilling|divination|trapper|sentinel|golem|ethereal) outfit/i.test(card.examine || "");
}

function isWickedEquipment(card) {
  return /^wicked (?:hood|robe top|legs|cape)$/i.test(card.name);
}

function isConstructionFurniture(card) {
  const constructionCape = /^construction (?:master )?cape$/i.test(card.name);
  return !constructionCape && (card.category.includes("Construction")
    || /\(construction(?:, historical)?\)/i.test(card.name));
}

function isConstructionBanner(card) {
  return /^banner \([^)]+\)$/i.test(card.name);
}

function isEligibleItem(card) {
  return !isAugmentedItemVariant(card) && !isConstructionBanner(card) && !isConstructionFurniture(card)
    && !isGrandExchangeSet(card)
    && !isExpertSkillcapeShard(card) && !isLootPinataItem(card) && !isRedundantSkillcapeVariant(card)
    && !isTitleScroll(card)
    && (HIGH_RARITIES.has(card.rarity)
    || card.equipable === true
    || CORE_ITEM_PATTERN.test(card.name)
    || card.category.includes("Clue Reward")
    || card.category.includes("Achievement Reward")
    || card.category.includes("Skilling Outfit")
    || card.category.includes("Wicked Equipment")
    || isSkillingOutfitItem(card)
    || isWickedEquipment(card)
    || card.category.includes("Currency")
    || card.category.includes("Accomplishment"));
}

module.exports = {
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
  isSkillingOutfitItem,
  isTitleScroll,
  isWickedEquipment
};
