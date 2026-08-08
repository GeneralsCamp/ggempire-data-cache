import assert from "node:assert/strict";
import { parseEventsFromHtml } from "./update-events.mjs";

const html = `
  <h2>Upcoming Events</h2>
  <div class="e-con-full e-con e-child"><p>Samurai Invasion</p><img data-orig-file="https://example.test/samurai.webp"><p>01/08 - 02/08<br>08/08 - 09/08</p></div>
  <div class="e-con-full e-con e-child"><p>Nomad Invasion</p><img src="https://example.test/nomad.webp"><p>Weekend<br>03/08 - 05/08</p></div>`;
const events = parseEventsFromHtml(html);
assert.equal(events.length, 2);
assert.deepEqual(events[0], {
    title: "Samurai Invasion",
    dates: ["01/08 - 02/08", "08/08 - 09/08"],
    dateGroups: null,
    imageUrl: "https://example.test/samurai.webp"
});
assert.deepEqual(events[1].dateGroups, [{ label: "Weekend", dates: ["03/08 - 05/08"] }]);
console.log("Event updater tests passed.");
