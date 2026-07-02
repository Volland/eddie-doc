const items = require("/tmp/eddie-items.json");
for (const it of items) {
  console.log(`[${it.kind}] anchored="${(it.anchoredText||"").slice(0,50)}"`);
  if (it.markedText) console.log(`         marked ="${it.markedText}"`);
  if (it.beforeText) console.log(`         before ="${it.beforeText}"`);
}
