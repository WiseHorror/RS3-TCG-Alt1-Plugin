// Recalculates catalogue credit values from stored source metadata only.
// This is intentionally local-only and does not contact the RuneScape Wiki.
const fs = require("fs");
const path = require("path");
const { cardCreditValue, maximumCardValue } = require("./card-value");

const cataloguePath = path.resolve(__dirname, "../src/generated-cards.json");
const cards = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));

let changed = 0;
for (const card of cards) {
  const previousValue = Number(card.value) || 0;
  const sourceValue = Math.max(0, Number(card.sourceValue) || 0);
  card.value = cardCreditValue(card, sourceValue);
  if (card.value !== previousValue) changed += 1;
}

fs.writeFileSync(cataloguePath, `${JSON.stringify(cards, null, 2)}\n`);
console.log(`Recalculated ${cards.length} cards; ${changed} values changed.`);
console.log(`Maximum card value: ${maximumCardValue.toLocaleString()} credits.`);
