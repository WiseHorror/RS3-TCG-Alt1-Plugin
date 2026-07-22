const economy = require("../src/economy-config.json");
const rarityConfig = require("../src/rarity-config.json");

const maximumCardValue = economy.packPrice * economy.maxCardPackValue;

function cardSourceValue(card) {
  const level = Number(card.level) || 0;
  const levelValue = level ** 2 * (card.category.includes("NPC") ? 1.5 : 1);
  return Math.max(
    Number(card.sourceValue) || Number(card.value) || 0,
    Number(card.geValue) || 0,
    Number(card.highAlchValue) || 0,
    (Number(card.experience) || 0) * 100,
    levelValue
  );
}

function cardCreditValue(card, sourceValue = cardSourceValue(card)) {
  const baseValue = rarityConfig[card.rarity]?.baseCreditValue || 0;
  const normalized = Math.min(1, Math.log1p(Math.max(0, sourceValue)) / Math.log1p(economy.sourceValueCap));
  const curvedValue = Math.round(baseValue
    + (maximumCardValue - baseValue) * normalized ** economy.valueCurveExponent);
  return Math.min(maximumCardValue, Math.max(baseValue, curvedValue));
}

module.exports = { cardCreditValue, cardSourceValue, maximumCardValue };
