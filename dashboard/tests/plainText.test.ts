import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentences, mainFinding, plainText } from "../src/plainText";

const now = new Date("2026-11-08T08:00:00Z");
const local = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

test("plainText: metric codes become everyday names; timestamps become local times; source ids are dropped", () => {
  const out = plainText("AMBIENT_TEMPERATURE_C last reading: 41.5 °C at 2026-11-08T06:45:08.117Z (source vision-e2e-temp), 59.2 minutes old.", now);
  assert.equal(out, `Ambient temperature last reading: 41.5 °C at ${local("2026-11-08T06:45:08.117Z")}, 59.2 minutes old.`);
  assert.equal(plainText("reading from source e2e-temp-01 at noon", now), "Reading at noon");
  assert.match(plainText("RELATIVE_HUMIDITY_PERCENT and SOUND_RAW and ULTRASONIC_DISTANCE_CM", now), /^Humidity and sound level and ultrasonic distance$/);
});
test("plainText: keeps numbers, units and wording otherwise unchanged", () => {
  assert.equal(plainText("Threshold 40 °C exceeded by 1.5 °C; humidity 45 %RH.", now), "Threshold 40 °C exceeded by 1.5 °C; humidity 45 %RH.");
});
test("firstSentences: decimals never split a sentence", () => {
  assert.equal(firstSentences("It is 41.5 °C now. It was 59.2 minutes old. Third.", 2), "It is 41.5 °C now. It was 59.2 minutes old.");
});
test("mainFinding: headline first, else the first two sentences of the summary, cleaned", () => {
  assert.equal(mainFinding({ headline: "Rack 01 is hot.", summary: "long" }, now), "Rack 01 is hot.");
  assert.equal(mainFinding({ summary: "A is simulated. B is stale. C is extra." }, now), "A is simulated. B is stale.");
  assert.equal(mainFinding({ headline: "  ", summary: "" }, now), "");
  assert.equal(mainFinding(null, now), "");
});
