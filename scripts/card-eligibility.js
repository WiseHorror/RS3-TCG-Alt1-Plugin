const HIGH_RARITIES = new Set(["Epic", "Legendary", "Mythic", "Godly"]);
const CORE_ITEM_PATTERN = /\b(?:ore|bar|logs?|planks?|wood|stone|clay|sand|glass|hide|leather|cloth|wool|flax|herb|seed|spore|compost|rune|essence|bones?|ashes|charm|energy|charge|fish|shark|lobster|salmon|trout|tuna|swordfish|bread|cake|pie|pizza|potion|overload|brew|restore|antipoison|serum|flask|jellyfish|soup|meat|arrow|arrowheads|bolts?|dart|knife|javelin|bow|crossbow|staff|wand|orb|sword|scimitar|dagger|mace|axe|hatchet|pickaxe|spear|halberd|whip|maul|hammer|tinderbox|rake|spade|secateurs|trowel|dibber|watering can|chisel|shears|pestle and mortar|saw|needle|glassblowing pipe|fishing rod|fishing net|lobster pot|harpoon|shield|defender|repriser|rebounder|armour|armor|helm|hood|hat|body|platebody|chainbody|legs|platelegs|skirt|plateskirt|boots|gloves|gauntlets|cape|ring|amulet|necklace|bracelet|relic|codex|blueprint|scrimshaw|sign|portent|pouch|scroll|tablet|talisman|tiara|urn|incense|cannonball|nails?|component|gizmo|augmentor|siphon|necroplasm|synapse|sinew|soil|sediment|gravel|salt)\b/i;

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

function isEligibleItem(card) {
  return !isAugmentedItemVariant(card) && !isRedundantSkillcapeVariant(card) && (HIGH_RARITIES.has(card.rarity)
    || CORE_ITEM_PATTERN.test(card.name)
    || card.category.includes("Clue Reward")
    || card.category.includes("Currency")
    || card.category.includes("Accomplishment"));
}

module.exports = { canonicalBaseTitle, isAugmentedItemVariant, isEligibleItem, isOverviewCard, isRedundantSkillcapeVariant };
