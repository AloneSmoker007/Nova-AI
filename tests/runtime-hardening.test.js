import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const indexSource = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
const appointmentSource = await fs.readFile(new URL("../src/services/appointment.service.js", import.meta.url), "utf8");
const bootstrapSource = await fs.readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8");

test("payment and OCR routes are registered before the terminal 404 handler", () => {
  const registration = indexSource.indexOf("registerTask16Routes(app);");
  const notFound = indexSource.indexOf('app.use((req, res) => res.status(404)');
  assert.ok(registration >= 0);
  assert.ok(notFound > registration);
  assert.doesNotMatch(bootstrapSource, /registerTask16Routes/);
});

test("AI prompt sections use real newlines", () => {
  assert.doesNotMatch(indexSource, /\.filter\(Boolean\)\.join\("\\\\n\\\\n"\)/);
  assert.match(indexSource, /\.filter\(Boolean\)\.join\("\\n\\n"\)/);
});

test("appointment conflict handling covers exclusion and unique conflicts", () => {
  assert.match(appointmentSource, /e\.code==="23P01"\s*\|\|\s*e\.code==="23505"/);
  assert.doesNotMatch(appointmentSource, /e\.code==="23P01"\|\|e\.code==="23P01"/);
  assert.match(appointmentSource, /try \{ await c\.query\("ROLLBACK"\); \} catch/);
});
